#!/usr/bin/env python3
"""Lector X - ingest.py

Normaliza los JSON crudos devueltos por la herramienta de lectura de X
(search_posts_all / get_posts_by_ids) y los guarda en data/posts/<id>.json,
y mantiene data/digest/YYYY-MM-DD.json con UN post recomendado + "por qué".

Solo lectura sobre X: este script no habla con X, solo procesa archivos locales.

Uso:
  python3 ingest.py raw/*.json                       # filtra, puntúa, guarda, recomienda
  python3 ingest.py raw/*.json --pick ID --why "texto 2-4 líneas"
  python3 ingest.py raw/*.json --date 2026-10-25 --topic IA
"""
import argparse, datetime as dt, glob, html, json, os, re, sys, tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def atomic_write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def extract_json(text):
    """Los archivos de herramienta pueden traer un prefijo; toma el objeto JSON."""
    i = text.find("{")
    j = text.rfind("}")
    return json.loads(text[i:j + 1])


def collect(paths):
    """Fusiona posts de varios crudos por id (texto más largo, métricas máximas)."""
    pool = {}
    for p in paths:
        with open(p, encoding="utf-8") as f:
            d = extract_json(f.read())
        users = {u["id"]: u for u in d.get("includes", {}).get("users", [])}
        for post in d.get("data", []):
            nt = post.get("note_tweet") or {}
            text = html.unescape(nt.get("text") or post.get("text") or "").replace("\r\n", "\n").strip()
            u = users.get(post.get("author_id"), {})
            m = post.get("public_metrics", {})
            cur = pool.get(post["id"])
            item = {
                "id": post["id"],
                "url": post.get("url") or f"https://x.com/{u.get('username', 'i')}/status/{post['id']}",
                "author_name": u.get("name") or u.get("username") or "Desconocido",
                "author_username": u.get("username") or "",
                "text": text,
                "created_at": post.get("created_at"),
                "lang": post.get("lang"),
                "is_reply": any(r.get("type") == "replied_to" for r in post.get("referenced_tweets", [])),
                "metrics": {
                    "likes": m.get("like_count", 0), "reposts": m.get("retweet_count", 0),
                    "replies": m.get("reply_count", 0), "quotes": m.get("quote_count", 0),
                    "bookmarks": m.get("bookmark_count", 0), "impressions": m.get("impression_count", 0),
                },
            }
            if cur:
                if len(cur["text"]) > len(item["text"]):
                    item["text"] = cur["text"]
                for k, v in cur["metrics"].items():
                    item["metrics"][k] = max(item["metrics"][k], v)
                item["lang"] = item["lang"] or cur["lang"]
                item["is_reply"] = item["is_reply"] or cur["is_reply"]
            pool[post["id"]] = item
    return pool


def repeated_ratio(text):
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    return 1 - len(set(lines)) / len(lines) if len(lines) > 2 else 0


def passes(p, flt):
    m, t = p["metrics"], p["text"]
    if p["is_reply"]:
        return False
    if m["likes"] < flt["min_likes"] or m["reposts"] < flt["min_reposts"]:
        return False
    if len(t) < flt["min_text_chars"] or repeated_ratio(t) > 0.5:
        return False
    if len(re.findall(r"^\s*\d+[.)]\s", t, re.M)) >= 5:  # listicles de spam
        return False
    if p["lang"] and p["lang"] not in flt["languages"]:
        return False
    if not re.search(flt["include_regex"], t, re.I):
        return False
    return not any(re.search(rx, t, re.I) for rx in flt["exclude_regex"])


def score(p):
    m = p["metrics"]
    return m["likes"] + 3 * m["reposts"] + 2 * m["replies"] + 2 * m["quotes"] + m["bookmarks"] + m["impressions"] / 500


def auto_tags(text, tag_map, limit=3):
    return [name for name, rx in (tag_map or {}).items() if re.search(rx, text, re.I)][:limit]


def auto_why(p):
    m = p["metrics"]
    return (f"Es el post con más tracción del día para este tema ({m['likes']:,} me gusta, {m['reposts']:,} reposts, "
            f"{m['impressions']:,} vistas).\nLo escribe {p['author_name']} (@{p['author_username']}).\n"
            "Léelo completo y subraya lo que te sirva.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("raw", nargs="+", help="JSON crudos (acepta globs)")
    ap.add_argument("--config", default=os.path.join(ROOT, "config.json"))
    ap.add_argument("--data", default=os.environ.get("LECTORX_DATA", os.path.join(ROOT, "data")))
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--topic", default=None)
    ap.add_argument("--pick", default=None, help="id del post recomendado (si no, el de mayor puntaje)")
    ap.add_argument("--why", default=None, help="2-4 líneas de por qué vale la pena leerlo")
    a = ap.parse_args()

    cfg = load_json(a.config, {})
    flt = cfg["filter"]
    topic = a.topic or cfg.get("topic", "IA")
    paths = sorted({f for g in a.raw for f in (glob.glob(g) or [g])})
    pool = collect(paths)
    keep = [p for p in pool.values() if passes(p, flt)]
    keep.sort(key=score, reverse=True)
    keep = keep[: flt["max_saved"]]
    if not keep:
        sys.exit("Ningún post pasó los filtros; no se guardó nada.")

    pick = next((p for p in keep if p["id"] == a.pick), None) if a.pick else keep[0]
    if a.pick and not pick:
        sys.exit(f"--pick {a.pick} no está entre los posts que pasaron los filtros.")
    why = (a.why or auto_why(pick)).strip()

    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    digest_dir = os.path.join(a.data, "digest")
    os.makedirs(os.path.join(a.data, "posts"), exist_ok=True)
    atomic_write(os.path.join(digest_dir, f"{a.date}.json"),
                 {"date": a.date, "topic": topic, "post_id": pick["id"], "why": why, "generated_at": now})
    recommended = set()
    for f in glob.glob(os.path.join(digest_dir, "*.json")):
        recommended.add((load_json(f, {}) or {}).get("post_id"))

    for p in keep:
        path = os.path.join(a.data, "posts", f"{p['id']}.json")
        old = load_json(path, {}) or {}
        rec = {
            "id": p["id"], "url": p["url"], "author_name": p["author_name"],
            "author_username": p["author_username"], "text": old.get("text") or p["text"],
            "created_at": p["created_at"], "metrics": p["metrics"], "topic": topic,
            "tags": old.get("tags") or auto_tags(p["text"], cfg.get("tags")),
            "fetched_at": old.get("fetched_at") or now,
            "recommended": p["id"] in recommended,
            "why": why if p["id"] == pick["id"] else old.get("why", ""),
        }
        atomic_write(path, rec)
    # los posts guardados antes que aparezcan en otro digest conservan su marca
    for f in glob.glob(os.path.join(a.data, "posts", "*.json")):
        r = load_json(f)
        if r and r["id"] in recommended and not r.get("recommended"):
            r["recommended"] = True
            atomic_write(f, r)

    print(f"Guardados {len(keep)} posts en {a.data}/posts (de {len(pool)} crudos).")
    print(f"Recomendado {a.date}: {pick['url']}")
    print(why)


if __name__ == "__main__":
    main()
