// Builds a Wikidata-style entity JSON dump .gz for tests, laid out the way the
// real generator (operations/dumps, dumpwikibasejson.sh) writes it: a gzip
// member holding "[", then each batch of entities gzipped on its own, a tiny
// member holding ",\n" between batches, and a closing member holding "\n]".
// Inflated, that is the usual `[`, one `{…},` per line, `]`.
import { gzipSync } from "node:zlib";

export interface DumpGz {
  /** The concatenated members. */
  gz: Buffer;
  /** What `gz` inflates to. */
  text: Buffer;
  /** Byte offset of every member in `gz`. */
  members: number[];
}

/**
 * `batches` are the entity groups, each becoming one member; a Buffer batch is
 * written verbatim as a stored (level 0) member, for content that must survive
 * compression byte for byte.
 */
export function dumpGz(batches: (object[] | Buffer)[]): DumpGz {
  const parts: Buffer[] = [];
  const texts: Buffer[] = [];
  const members: number[] = [];
  let offset = 0;
  const push = (raw: Buffer, level = 9): void => {
    const member = gzipSync(raw, { level });
    members.push(offset);
    offset += member.length;
    parts.push(member);
    texts.push(raw);
  };
  push(Buffer.from("[\n"));
  batches.forEach((batch, i) => {
    if (i > 0) push(Buffer.from(",\n"));
    if (Buffer.isBuffer(batch)) push(batch, 0);
    else push(Buffer.from(batch.map((e) => JSON.stringify(e)).join(",\n")));
  });
  push(Buffer.from("\n]\n"));
  return { gz: Buffer.concat(parts), text: Buffer.concat(texts), members };
}
