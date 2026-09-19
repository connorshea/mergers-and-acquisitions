// Wikimedia's User-Agent policy asks every client to identify itself with a
// contact. Override with USER_AGENT on Toolforge to add the tool's maintainer.
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../../package.json") as {
  name: string;
  version: string;
};

export function userAgent(): string {
  return (
    process.env.USER_AGENT ??
    `${pkg.name}/${pkg.version} (https://github.com/connorshea/mergers-and-acquisitions)`
  );
}
