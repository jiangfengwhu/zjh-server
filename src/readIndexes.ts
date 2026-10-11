/** Derived indexes live beside the existing KV records in the same SQLite DO.
 * Call write methods inside the canonical KV transaction. Old records are
 * backfilled once; reads never rescan the global KV collection after migration.
 */
type MarketRecord = { manifest: { appId: string }; authorId?: string | null; authorOfficial?: boolean; category?: string; publishedAt?: number; title?: string; summary?: string };
const grams = (text: string, query = false) => {
  const chars = Array.from(text);
  return [...new Set(query && chars.length > 1
    ? chars.slice(0, -1).map((char, index) => `b:${char}${chars[index + 1]}`)
    : [...chars.map(char => `c:${char}`), ...chars.slice(0, -1).map((char, index) => `b:${char}${chars[index + 1]}`)])];
};
const placeholders = (length: number) => Array(length).fill("?").join(",");
export class MarketIndex {
  private flight?: Promise<void>;
  constructor(private ctx: DurableObjectState) {}
  ensure() { return this.flight ??= this.ctx.blockConcurrencyWhile(async () => {
    const { sql } = this.ctx.storage;
    sql.exec("CREATE TABLE IF NOT EXISTS market_read (app_id TEXT PRIMARY KEY, author_id TEXT, category TEXT, official INTEGER, at INTEGER, search_text TEXT)");
    sql.exec("CREATE INDEX IF NOT EXISTS market_read_order ON market_read(at DESC, app_id)");
    sql.exec("CREATE INDEX IF NOT EXISTS market_read_author ON market_read(author_id, at DESC, app_id)");
    sql.exec("CREATE INDEX IF NOT EXISTS market_read_category ON market_read(category, at DESC, app_id)");
    sql.exec("CREATE INDEX IF NOT EXISTS market_read_official ON market_read(official, at DESC, app_id)");
    sql.exec("CREATE TABLE IF NOT EXISTS market_gram (gram TEXT, app_id TEXT, PRIMARY KEY(gram, app_id))");
    sql.exec("CREATE INDEX IF NOT EXISTS market_gram_app ON market_gram(app_id)");
    if (await this.ctx.storage.get("market-read-index:v1")) return;
    sql.exec("DELETE FROM market_read"); sql.exec("DELETE FROM market_gram");
    let cursor: string | undefined;
    do {
      const page = await this.ctx.storage.list<MarketRecord>({ prefix: "shared:", startAfter: cursor, limit: 128 });
      this.ctx.storage.transactionSync(() => { for (const entry of page.values()) this.put(entry); });
      if (page.size < 128) break;
      cursor = [...page.keys()].at(-1);
    } while (cursor);
    await this.ctx.storage.put("market-read-index:v1", true);
  }).catch(error => { this.flight = undefined; throw error; }); }
  put(entry: MarketRecord) {
    const id = entry.manifest.appId;
    const text = `${entry.title ?? ""} ${entry.summary ?? ""}`.toLowerCase();
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO market_read VALUES (?, ?, ?, ?, ?, ?)", id, entry.authorId ?? "", entry.category || "other", entry.authorOfficial ? 1 : 0, entry.publishedAt || 0, text);
    this.ctx.storage.sql.exec("DELETE FROM market_gram WHERE app_id = ?", id);
    for (const gram of grams(text)) this.ctx.storage.sql.exec("INSERT INTO market_gram VALUES (?, ?)", gram, id);
  }
  remove(id: string) { this.ctx.storage.sql.exec("DELETE FROM market_read WHERE app_id = ?", id); this.ctx.storage.sql.exec("DELETE FROM market_gram WHERE app_id = ?", id); }
  page(input: { appId?: string | null; authorId?: string | null; category?: string; query?: string; after?: { at: number; id: string }; limit?: number }) {
    const clauses: string[] = []; const values: (string | number)[] = [];
    if (input.appId) { clauses.push("app_id = ?"); values.push(input.appId); }
    if (input.authorId) { clauses.push("author_id = ?"); values.push(input.authorId); }
    if (input.category === "official") clauses.push("official = 1");
    else if (input.category) { clauses.push("category = ?"); values.push(input.category); }
    if (input.query) {
      const terms = grams(input.query, true);
      clauses.push(`app_id IN (SELECT app_id FROM market_gram WHERE gram IN (${placeholders(terms.length)}) GROUP BY app_id HAVING COUNT(*) = ?)`);
      values.push(...terms, terms.length);
      clauses.push("instr(search_text, ?) > 0"); values.push(input.query);
    }
    const base = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const total = this.ctx.storage.sql.exec<{ total: number }>(`SELECT COUNT(*) AS total FROM market_read${base}`, ...values).one().total;
    if (input.after) { clauses.push("(at < ? OR (at = ? AND app_id > ?))"); values.push(input.after.at, input.after.at, input.after.id); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return { total, rows: this.ctx.storage.sql.exec<{ app_id: string; at: number }>(`SELECT app_id, at FROM market_read${where} ORDER BY at DESC, app_id${input.limit ? " LIMIT ?" : ""}`, ...values, ...(input.limit ? [input.limit] : [])).toArray() };
  }
}

export class TimelineIndex {
  private flight?: Promise<void>;
  constructor(private ctx: DurableObjectState) {}
  ensure() { return this.flight ??= this.ctx.blockConcurrencyWhile(async () => {
    const { sql } = this.ctx.storage;
    sql.exec("CREATE TABLE IF NOT EXISTS timeline_read (key TEXT PRIMARY KEY, author_id TEXT)");
    sql.exec("CREATE INDEX IF NOT EXISTS timeline_read_author ON timeline_read(author_id, key)");
    sql.exec("CREATE TABLE IF NOT EXISTS timeline_follow (viewer TEXT, author_id TEXT, PRIMARY KEY(viewer, author_id))");
    sql.exec("CREATE TABLE IF NOT EXISTS notice_read (key TEXT PRIMARY KEY, owner TEXT, category TEXT)");
    sql.exec("CREATE INDEX IF NOT EXISTS notice_read_category ON notice_read(owner, category, key)");
    if (await this.ctx.storage.get("timeline-read-index:v1")) return;
    for (const table of ["timeline_read", "timeline_follow", "notice_read"]) sql.exec(`DELETE FROM ${table}`);
    for (const prefix of ["post:", "follow:", "notice:"]) {
      let cursor: string | undefined;
      do {
        const page = await this.ctx.storage.list<{ author?: { id: string }; kind?: string } | boolean>({ prefix, startAfter: cursor, limit: 128 });
        this.ctx.storage.transactionSync(() => {
          for (const [key, item] of page) {
            if (prefix === "post:" && typeof item !== "boolean" && item.author) this.post(key, item.author.id);
            if (prefix === "follow:" && item) { const [, viewer, author] = key.split(":"); this.follow(viewer, author, true); }
            if (prefix === "notice:" && typeof item !== "boolean") this.notice(key, key.split(":")[1], item.kind || "");
          }
        });
        if (page.size < 128) break;
        cursor = [...page.keys()].at(-1);
      } while (cursor);
    }
    await this.ctx.storage.put("timeline-read-index:v1", true);
  }).catch(error => { this.flight = undefined; throw error; }); }
  post(key: string, author: string) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO timeline_read VALUES (?, ?)", key, author); }
  removePost(key: string) { this.ctx.storage.sql.exec("DELETE FROM timeline_read WHERE key = ?", key); }
  follow(viewer: string, author: string, wanted: boolean) {
    if (wanted) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO timeline_follow VALUES (?, ?)", viewer, author);
    else this.ctx.storage.sql.exec("DELETE FROM timeline_follow WHERE viewer = ? AND author_id = ?", viewer, author);
  }
  posts(input: { author?: string; viewer?: string; after?: string; limit: number }) {
    const clauses: string[] = []; const values: (string | number)[] = [];
    if (input.author) { clauses.push("p.author_id = ?"); values.push(input.author); }
    if (input.viewer) { clauses.push("p.author_id IN (SELECT author_id FROM timeline_follow WHERE viewer = ?)"); values.push(input.viewer); }
    if (input.after) { clauses.push("p.key > ?"); values.push(input.after); }
    return this.ctx.storage.sql.exec<{ key: string }>(`SELECT p.key FROM timeline_read p${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY p.key LIMIT ?`, ...values, input.limit).toArray().map(row => row.key);
  }
  notice(key: string, owner: string, kind: string) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO notice_read VALUES (?, ?, ?)", key, owner, kind.startsWith("work-") ? "creation" : "interaction"); }
  removeNotice(key: string) { this.ctx.storage.sql.exec("DELETE FROM notice_read WHERE key = ?", key); }
  notices(owner: string, category: string, after: string | undefined, limit: number) {
    return this.ctx.storage.sql.exec<{ key: string }>(`SELECT key FROM notice_read WHERE owner = ? AND category = ?${after ? " AND key > ?" : ""} ORDER BY key LIMIT ?`, owner, category, ...(after ? [after] : []), limit).toArray().map(row => row.key);
  }
}
