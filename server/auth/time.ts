// DATETIME columns are `mode: "string"` and the driver returns them as
// `YYYY-MM-DD HH:MM:SS`. Every auth timestamp that gets *compared* (session
// expiry, token expiry) is written from JS in UTC via these helpers and read
// back the same way, so the DB server's session time zone never matters.

export function toSqlDatetime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export function fromSqlDatetime(s: string): Date {
  return new Date(`${s.replace(" ", "T")}Z`);
}

export function addSeconds(d: Date, seconds: number): Date {
  return new Date(d.getTime() + seconds * 1000);
}
