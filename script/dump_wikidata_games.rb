#!/usr/bin/env ruby
# frozen_string_literal: true

# Dump every video game item on Wikidata into a local JSON blob.
#
# This is a standalone client — it does NOT need the Rails app or a database. It
# talks to the same SPARQL endpoint the import rake tasks use (QLever's Wikidata
# mirror by default).
#
# Unlike the earlier version of this script, which hydrated only a hand-picked
# set of fields (Steam ID, developers, publishers, ...), this dumps ALL truthy
# properties for each game. For every item it walks every `wdt:` direct-claim
# statement and records the property (Pxxx) together with its value(s), so the
# blob is a faithful dump of everything Wikidata asserts about each game rather
# than a curated subset. Labels are kept alongside (en + the 'mul' multilingual
# label) because those are not properties and are handy for downstream tooling.
#
# The driver set is "instances of video game (Q7889) or free/libre video game
# (Q21125433) that have an en or mul label" — the same population the games
# import walks. Everything else is hydrated in bulk, one chunk at a time.
#
# Value shape: each property maps to an array of value objects. Entity-valued
# statements become {"type":"entity","value":"Q123"}; literal-valued statements
# become {"type":"literal","value":"440","datatype":"...","lang":"en"} (datatype
# and lang present only when Wikidata returns them). "Unknown value" blank nodes
# are skipped. Values are de-duplicated and left otherwise exactly as the
# endpoint returns them — this is a faithful dump, no normalization.
#
# Output:
#   A single JSON blob (default tmp/wikidata_games.json) shaped as:
#     { "generated_at": ..., "endpoint": ..., "game_count": N, "games": [ {...}, ... ] }
#   where each game is:
#     { "wikidata_id": 42, "qid": "Q42", "label": ..., "en_label": ...,
#       "mul_label": ..., "properties": { "P178": [ {...}, ... ], ... } }
#   The blob is streamed from a JSONL sidecar so memory stays flat even across
#   the ~1M items, rather than building one giant array/string in memory.
#
# Usage:
#   ruby script/dump_wikidata_games.rb
#
# Environment variables:
#   OUTPUT_JSON               where to write the blob (default tmp/wikidata_games.json)
#   WIKIDATA_SPARQL_ENDPOINT  SPARQL endpoint (default https://qlever.dev/api/wikidata;
#                             set to https://query.wikidata.org/sparql to use WDQS)
#   WIKIDATA_CONTACT_EMAIL    optional contact address added to the SPARQL User-Agent
#   CHUNK_SIZE                games hydrated per SPARQL round-trip (default 250).
#                             Lower it if the all-properties query times out or
#                             returns responses too large for the endpoint.
#   ID_PAGE_SIZE              driver item IDs fetched per page (default 100000).
#                             The full list is paged rather than pulled in one
#                             ~1M-row response, which tends to truncate mid-stream.
#   LIMIT                     cap the number of games dumped (for a quick test run)
#
# Resilience and resume:
#   * Transient network failures (dropped connections, timeouts, TLS resets) and
#     HTTP 429s are retried with backoff on every request, so a blip doesn't
#     abort a long run.
#   * The driver item list is fetched a page at a time (see ID_PAGE_SIZE),
#     appended to "<output>.ids.partial.jsonl" with the next offset tracked in
#     "<output>.ids.progress.json", so an interrupted list fetch resumes from the
#     last completed page. Once complete it is cached to "<output>.ids.json" and
#     the hydrated
#     games are appended to "<output>.partial.jsonl" one per line, with the last
#     completed chunk recorded in "<output>.progress.json". If the run is
#     interrupted, simply re-run: it reuses the cached ID list and resumes from
#     the next unfinished chunk instead of starting over. The sidecars are
#     removed once the final blob has been written; delete them by hand to force
#     a fresh run.

require 'net/http'
require 'openssl'
require 'uri'
require 'json'
require 'time'
require 'zlib'

module DumpWikidataGames
  SPARQL_ENDPOINT = ENV.fetch('WIKIDATA_SPARQL_ENDPOINT', 'https://qlever.dev/api/wikidata')
  CHUNK_SIZE = Integer(ENV.fetch('CHUNK_SIZE', '250'))
  # The driver item list is fetched in pages of this many IDs rather than one
  # ~1M-row response, which is prone to being truncated mid-stream.
  ID_PAGE_SIZE = Integer(ENV.fetch('ID_PAGE_SIZE', '100000'))
  LIMIT = ENV['LIMIT'].to_s.strip.empty? ? nil : Integer(ENV['LIMIT'])

  # Where the final JSON blob is written.
  OUTPUT_JSON = ENV.fetch('OUTPUT_JSON', 'tmp/wikidata_games.json')

  # Standard Wikidata prefixes. QLever (unlike WDQS) requires them declared on
  # every query — see lib/wikidata_sparql.rb.
  PREFIXES = <<~SPARQL
    PREFIX wd: <http://www.wikidata.org/entity/>
    PREFIX wdt: <http://www.wikidata.org/prop/direct/>
    PREFIX wikibase: <http://wikiba.se/ontology#>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
  SPARQL

  # Pace SPARQL requests to stay under QLever's rate limit, and back off on 429.
  # Mirrors lib/wikidata_sparql.rb's approach.
  INTER_QUERY_DELAY_SECONDS = 1
  INITIAL_BACKOFF_SECONDS = 4
  MAX_SPARQL_ATTEMPTS = 5

  # Retry transient network failures on any request so a single dropped
  # connection or TLS reset doesn't abort a long-running dump.
  MAX_NETWORK_ATTEMPTS = 6
  TRANSIENT_NETWORK_ERRORS = [
    Errno::ECONNRESET, Errno::ECONNREFUSED, Errno::EHOSTUNREACH,
    Errno::ENETUNREACH, Errno::ETIMEDOUT, Errno::EPIPE,
    Net::OpenTimeout, Net::ReadTimeout,
    OpenSSL::SSL::SSLError, EOFError, SocketError, IOError,
    # A truncated gzip/deflate response (Net::HTTP inflates transparently) shows
    # up here rather than as a plain socket error; retrying re-fetches it.
    Zlib::Error
  ].freeze

  USER_AGENT = [
    'vglist Wikidata dumper/2.0',
    ENV['WIKIDATA_CONTACT_EMAIL'].to_s.empty? ? nil : "(#{ENV['WIKIDATA_CONTACT_EMAIL']})",
    "Ruby #{RUBY_VERSION}"
  ].compact.join(' ')

  Retry = Class.new(StandardError)

  module_function

  def run
    ensure_output_dir

    ids = load_or_fetch_ids
    ids = ids.first(LIMIT) if LIMIT
    warn "#{ids.length} video game items to dump (chunk size #{CHUNK_SIZE})."

    partial, progress = sidecar_paths
    start_chunk = resume_chunk(progress, ids.length)

    chunks = ids.each_slice(CHUNK_SIZE).to_a
    warn "Resuming from chunk #{start_chunk + 1}/#{chunks.length}." if start_chunk.positive?

    File.open(partial, start_chunk.positive? ? 'a' : 'w') do |file|
      chunks.each_with_index do |chunk, index|
        next if index < start_chunk

        hydrate_chunk(chunk).each { |game| file.puts JSON.generate(game) }
        file.flush
        write_checkpoint(progress, chunk_index: index, chunk_size: CHUNK_SIZE, total: ids.length)

        done = [(index + 1) * CHUNK_SIZE, ids.length].min
        warn "  chunk #{index + 1}/#{chunks.length} (#{done}/#{ids.length} games) ..."
      end
    end

    count = write_blob(partial, OUTPUT_JSON)
    clear_sidecars
    warn "Wrote #{count} games to #{OUTPUT_JSON}."
  end

  # ---- Driver query ----------------------------------------------------------

  # Numeric Wikidata IDs of every video game item, cached to a sidecar so a
  # resumed run doesn't re-run the (single, but heavy) driver query.
  def load_or_fetch_ids
    cache = ids_cache_path
    if File.exist?(cache)
      warn "Reusing cached item list from #{cache} ..."
      return parse_json(File.read(cache))
    end

    warn "Fetching the full list of video game items from #{SPARQL_ENDPOINT} ..."
    ids = fetch_game_ids
    File.write(cache, JSON.generate(ids))
    ids
  end

  # The same driver population the games import uses: instances of 'video game'
  # or 'free or open source video game' that have an en or mul label.
  #
  # Fetched a page at a time (ORDER BY + LIMIT/OFFSET) instead of one enormous
  # response, and made resumable: each page's IDs are appended to an
  # "<output>.ids.partial.jsonl" sidecar and the next offset recorded in
  # "<output>.ids.progress.json", so an interrupted list fetch picks up from the
  # last completed page rather than starting the whole crawl over.
  def fetch_game_ids
    partial = ids_partial_path
    progress = ids_progress_path

    ids = []
    offset = 0
    if File.exist?(partial) && File.exist?(progress) && resumable_id_fetch?(progress)
      ids = File.foreach(partial).map { |line| Integer(line.strip) }
      offset = parse_json(File.read(progress))['next_offset'].to_i
      warn "Resuming item-list fetch from offset #{offset} (#{ids.length} ids so far) ..."
    end

    File.open(partial, offset.positive? ? 'a' : 'w') do |file|
      loop do
        page = fetch_game_id_page(offset, ID_PAGE_SIZE)
        page.each { |id| file.puts(id) }
        file.flush
        ids.concat(page)
        offset += ID_PAGE_SIZE
        File.write(progress, JSON.generate('next_offset' => offset, 'page_size' => ID_PAGE_SIZE, 'count' => ids.length))
        warn "  fetched #{ids.length} item ids (last page #{page.length}) ..."
        break if page.length < ID_PAGE_SIZE
      end
    end

    ids.uniq
  end

  # One page of the driver population, ordered so LIMIT/OFFSET slices are stable
  # and disjoint across pages.
  def fetch_game_id_page(offset, limit)
    query = <<~SPARQL
      SELECT DISTINCT ?item WHERE {
        VALUES ?videoGameTypes { wd:Q7889 wd:Q21125433 }.
        ?item wdt:P31 ?videoGameTypes;
              rdfs:label ?label .
          FILTER(lang(?label) = "en" || lang(?label) = "mul")
      }
      ORDER BY ?item
      LIMIT #{limit} OFFSET #{offset}
    SPARQL

    bindings = sparql_query(query).dig('results', 'bindings')
    bindings.filter_map { |binding| qid_to_int(binding.dig('item', 'value')) }
  end

  # A partial ID fetch is only resumable if it was paged the same way; a changed
  # ID_PAGE_SIZE shifts every offset, so restart the list fetch from scratch.
  def resumable_id_fetch?(progress)
    parse_json(File.read(progress))['page_size'] == ID_PAGE_SIZE
  rescue StandardError
    false
  end

  # ---- Hydration -------------------------------------------------------------

  # Fetch labels and every property for a chunk of games and merge them into one
  # hash per game, in item order.
  def hydrate_chunk(chunk)
    labels = fetch_labels(chunk)
    props = fetch_all_properties(chunk)

    chunk.map do |wikidata_id|
      label = labels[wikidata_id] || {}
      {
        'wikidata_id' => wikidata_id,
        'qid' => "Q#{wikidata_id}",
        'label' => label[:label],
        'en_label' => label[:en_label],
        'mul_label' => label[:mul_label],
        'properties' => props[wikidata_id] || {}
      }
    end
  end

  # English and 'mul' (multilingual) labels for a chunk. Both are OPTIONAL and
  # collapsed with SAMPLE so each game yields at most one row.
  def fetch_labels(wikidata_ids)
    query = <<~SPARQL
      SELECT ?item (SAMPLE(?enLabel) AS ?en) (SAMPLE(?mulLabel) AS ?mul)
      WHERE {
        #{values_clause(wikidata_ids)}
        OPTIONAL { ?item rdfs:label ?enLabel. FILTER(lang(?enLabel) = "en") }
        OPTIONAL { ?item rdfs:label ?mulLabel. FILTER(lang(?mulLabel) = "mul") }
      }
      GROUP BY ?item
    SPARQL

    sparql_query(query).dig('results', 'bindings').each_with_object({}) do |binding, labels|
      wikidata_id = qid_to_int(binding.dig('item', 'value'))
      next unless wikidata_id

      en = value(binding, 'en')
      mul = value(binding, 'mul')
      labels[wikidata_id] = {
        label: en || mul, # Prefer the English label, falling back to 'mul'.
        en_label: en,
        mul_label: mul
      }
    end
  end

  # Every truthy (`wdt:`) statement for a chunk of games, in a single query.
  # Restricting to predicates that are the `directClaim` of some property keeps
  # us to real Wikidata properties (Pxxx) and drops rdfs:label, schema:*,
  # owl:sameAs, and other non-property triples. Returns
  # { wikidata_id => { "P123" => [value_object, ...] } }.
  def fetch_all_properties(wikidata_ids)
    query = <<~SPARQL
      SELECT ?item ?prop ?value WHERE {
        #{values_clause(wikidata_ids)}
        ?item ?propUrl ?value.
        ?prop wikibase:directClaim ?propUrl.
      }
    SPARQL

    result = Hash.new { |hash, key| hash[key] = {} }
    sparql_query(query).dig('results', 'bindings').each do |binding|
      wikidata_id = qid_to_int(binding.dig('item', 'value'))
      next unless wikidata_id

      property = property_id(binding.dig('prop', 'value'))
      next unless property

      parsed = parse_value(binding['value'])
      next if parsed.nil?

      (result[wikidata_id][property] ||= []) << parsed
    end

    result.each_value { |props| props.each_value(&:uniq!) }
    result
  end

  # Turn a SPARQL result value node into a compact, faithful value object.
  # Entities collapse to {"type":"entity","value":"Q123"}; literals keep their
  # raw value plus datatype/lang when present; "unknown value" blank nodes are
  # dropped (they carry no information worth keeping).
  def parse_value(node)
    return nil if node.nil?

    type = node['type']
    raw = node['value']

    case type
    when 'bnode'
      nil
    when 'uri'
      entity = raw.to_s[%r{/entity/(Q\d+)\z}, 1]
      entity ? { 'type' => 'entity', 'value' => entity } : { 'type' => 'uri', 'value' => raw }
    else
      out = { 'type' => 'literal', 'value' => raw }
      out['datatype'] = node['datatype'] if node['datatype']
      out['lang'] = node['xml:lang'] if node['xml:lang']
      out
    end
  end

  # ---- Output ----------------------------------------------------------------

  # Stream the JSONL sidecar into the final JSON blob so we never hold every
  # game (nor one giant serialized string) in memory at once. Returns the count.
  def write_blob(partial, output)
    count = 0
    File.open(output, 'w') do |out|
      out.write("{\n")
      out.write(%(  "generated_at": #{JSON.generate(Time.now.utc.iso8601)},\n))
      out.write(%(  "endpoint": #{JSON.generate(SPARQL_ENDPOINT)},\n))
      out.write(%(  "games": [\n))

      first = true
      File.foreach(partial) do |line|
        line = line.strip
        next if line.empty?

        out.write(",\n") unless first
        first = false
        out.write("    #{line}")
        count += 1
      end

      out.write("\n  ],\n")
      out.write(%(  "game_count": #{count}\n))
      out.write("}\n")
    end
    count
  end

  # ---- SPARQL / HTTP ---------------------------------------------------------

  def sparql_query(query)
    uri = URI.parse(SPARQL_ENDPOINT)
    attempt = 0

    begin
      attempt += 1
      sleep(INTER_QUERY_DELAY_SECONDS)

      request = Net::HTTP::Post.new(uri)
      request['Accept'] = 'application/sparql-results+json'
      request['Content-Type'] = 'application/x-www-form-urlencoded'
      request['User-Agent'] = USER_AGENT
      request.set_form_data('query' => PREFIXES + query)

      response = perform_http(uri, request, description: 'SPARQL')

      if response.code == '429' && attempt < MAX_SPARQL_ATTEMPTS
        backoff = INITIAL_BACKOFF_SECONDS * (2**(attempt - 1)) # 4, 8, 16, 32 seconds
        warn "  rate limited (429); retrying in #{backoff}s"
        sleep(backoff)
        raise Retry
      end

      # Gateway errors (nginx 502/503/504) mean the upstream QLever hiccuped or
      # timed out — transient, so back off and retry rather than aborting the run.
      # (A genuine query error comes back as 500 with a JSON `exception` body,
      # handled below, and is not retried here.)
      if %w[502 503 504].include?(response.code) && attempt < MAX_SPARQL_ATTEMPTS
        backoff = INITIAL_BACKOFF_SECONDS * (2**(attempt - 1))
        warn "  gateway error (HTTP #{response.code}); retrying in #{backoff}s"
        sleep(backoff)
        raise Retry
      end
      raise "SPARQL HTTP #{response.code}: #{response.body}" unless response.is_a?(Net::HTTPSuccess)

      body = parse_json(response.body)
      raise "SPARQL error: #{body['exception']}" if body['exception']

      body
    rescue Retry
      retry
    end
  end

  def perform_http(uri, request, description:)
    with_network_retry(description) { http_start(uri).request(request) }
  end

  def http_start(uri)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == 'https'
    http.open_timeout = 15
    http.read_timeout = 300
    http
  end

  def with_network_retry(description)
    attempt = 0
    begin
      attempt += 1
      yield
    rescue *TRANSIENT_NETWORK_ERRORS => e
      raise if attempt >= MAX_NETWORK_ATTEMPTS

      backoff = [2**attempt, 60].min # 2, 4, 8, 16, 32, 60
      warn "  #{description} network error (attempt #{attempt}/#{MAX_NETWORK_ATTEMPTS}): " \
           "#{e.class}: #{e.message}; retrying in #{backoff}s"
      sleep(backoff)
      retry
    end
  end

  # ---- Resume bookkeeping ----------------------------------------------------

  def sidecar_paths
    ["#{OUTPUT_JSON}.partial.jsonl", "#{OUTPUT_JSON}.progress.json"]
  end

  def ids_cache_path
    "#{OUTPUT_JSON}.ids.json"
  end

  def ids_partial_path
    "#{OUTPUT_JSON}.ids.partial.jsonl"
  end

  def ids_progress_path
    "#{OUTPUT_JSON}.ids.progress.json"
  end

  # The next chunk index to process. Returns the chunk after the last completed
  # one when a matching, still-valid checkpoint and partial file both exist.
  def resume_chunk(progress, total)
    partial, = sidecar_paths
    return 0 unless File.exist?(progress) && File.exist?(partial)

    checkpoint = parse_json(File.read(progress))
    # A changed chunk size or item count invalidates the recorded chunk index.
    return 0 unless checkpoint['chunk_size'] == CHUNK_SIZE && checkpoint['total'] == total

    checkpoint['chunk_index'].to_i + 1
  rescue StandardError => e
    warn "Ignoring unreadable checkpoint #{progress}: #{e.message}"
    0
  end

  def write_checkpoint(progress, chunk_index:, chunk_size:, total:)
    File.write(progress, JSON.generate(
                           'chunk_index' => chunk_index,
                           'chunk_size' => chunk_size,
                           'total' => total,
                           'updated_at' => Time.now.utc.iso8601
                         ))
  end

  def clear_sidecars
    paths = sidecar_paths + [ids_cache_path, ids_partial_path, ids_progress_path]
    paths.each { |path| File.delete(path) if File.exist?(path) }
  end

  # ---- Helpers ---------------------------------------------------------------

  def ensure_output_dir
    dir = File.dirname(OUTPUT_JSON)
    Dir.mkdir(dir) unless dir == '.' || Dir.exist?(dir)
  end

  # A `VALUES ?item { wd:Q1 wd:Q2 ... }` clause binding a chunk of games.
  def values_clause(wikidata_ids)
    "VALUES ?item { #{wikidata_ids.map { |id| "wd:Q#{id}" }.join(' ')} }"
  end

  # Read a binding's value out of a SPARQL JSON result row, or nil if unbound.
  def value(binding, key)
    binding.dig(key, 'value')
  end

  # "http://www.wikidata.org/entity/Q42" -> 42
  def qid_to_int(uri)
    match = uri.to_s.match(%r{/Q(\d+)\z})
    match && match[1].to_i
  end

  # "http://www.wikidata.org/entity/P123" -> "P123"
  def property_id(uri)
    match = uri.to_s.match(%r{/(P\d+)\z})
    match && match[1]
  end

  def parse_json(body)
    JSON.parse(body)
  rescue JSON::ParserError => e
    raise "Could not parse response as JSON (#{e.message}): #{body.to_s[0, 200]}"
  end
end

DumpWikidataGames.run if $PROGRAM_NAME == __FILE__
