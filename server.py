#!/usr/bin/env python3
"""Lector X - servidor (python3 stdlib, sin dependencias, sin base de datos).

Datos en JSON locales:  <data>/posts/<id>.json, <data>/digest/YYYY-MM-DD.json,
                        <data>/highlights.json, <data>/notes.json
Variables: LECTORX_DATA (carpeta de datos, default ./data), PORT (default config.json -> 8787).
"""
import datetime as dt, glob, json, os, re, sys, tempfile, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.environ.get("LECTORX_DATA", os.path.join(ROOT, "data")))
STATIC = os.path.join(ROOT, "static")
LOCK = threading.RLock()
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json"}


def now():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError:
        return default


def write_json(path, obj):  # escritura atómica: tmp + rename
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def p_file(name):
    return os.path.join(DATA, name)


def load_posts():
    posts = [read_json(f, None) for f in glob.glob(os.path.join(DATA, "posts", "*.json"))]
    return [p for p in posts if p]


def get_post(pid):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", pid or ""):
        return None
    return read_json(os.path.join(DATA, "posts", pid + ".json"), None)


def digests():
    out = [read_json(f, None) for f in glob.glob(os.path.join(DATA, "digest", "*.json"))]
    return sorted([d for d in out if d], key=lambda d: d["date"], reverse=True)


def themes(p):
    return list(p.get("tags") or ([p["topic"]] if p.get("topic") else []))


def today_str():
    return dt.date.today().isoformat()


def read_map():
    return read_json(p_file("read.json"), {})


def review_state():
    rv = read_json(p_file("review.json"), {})
    rv.setdefault("items", {})
    rv.setdefault("days", {})
    return rv


def pick_review(day, rv, hls, n=3):
    """Selección determinista por fecha: menos repasados primero (sin contar los repasos de hoy),
    los marcados 'repasar de nuevo' antes a igualdad, y rotación estable por sha1(fecha|id)."""
    import hashlib

    def key(h):
        hist = [e for e in rv["items"].get(h["id"], {}).get("history", []) if e["date"] != day]
        again = bool(hist) and hist[-1]["result"] == "again"
        return (len(hist), 0 if again else 1, hashlib.sha1(f"{day}|{h['id']}".encode()).hexdigest())
    return [h["id"] for h in sorted(hls, key=key)[:n]]


def review_today():
    day = today_str()
    hls = {h["id"]: h for h in read_json(p_file("highlights.json"), [])}
    rv = review_state()
    ids = [i for i in rv["days"].get(day, []) if i in hls] or pick_review(day, rv, list(hls.values()))
    items = []
    for i in ids:
        h, it = hls[i], rv["items"].get(i, {})
        post = get_post(h["post_id"]) or {}
        today_entries = [e for e in it.get("history", []) if e["date"] == day]
        items.append({"highlight": h, "count": it.get("count", 0), "last_reviewed": it.get("last_reviewed"),
                      "last_result": it.get("last_result"), "reviewed_today": bool(today_entries),
                      "result_today": today_entries[-1]["result"] if today_entries else None,
                      "post": {k: post.get(k) for k in ("id", "url", "author_name", "author_username", "sample")}})
    return {"date": day, "target": 3, "items": items, "done": sum(1 for x in items if x["reviewed_today"]), "total": len(items)}


def post_review(b):
    hid, result = b.get("highlight_id"), b.get("result")
    if result not in ("remembered", "again"):
        raise ApiError(400, "result debe ser remembered o again")
    with LOCK:
        hls = read_json(p_file("highlights.json"), [])
        if not any(h["id"] == hid for h in hls):
            raise ApiError(404, "Subrayado no existe")
        day, rv = today_str(), review_state()
        rv["days"].setdefault(day, pick_review(day, rv, hls))  # congela la selección del día
        for old in sorted(rv["days"])[:-60]:
            rv["days"].pop(old)
        it = rv["items"].setdefault(hid, {"count": 0, "history": []})
        it["history"].append({"date": day, "at": now(), "result": result})
        it.update({"count": len(it["history"]), "last_reviewed": now(), "last_result": result})
        write_json(p_file("review.json"), rv)
    return it


def set_read(pid, b):
    if not get_post(pid):
        raise ApiError(404, "Post no existe")
    with LOCK:
        rm = read_map()
        if b.get("read", True):
            rm.setdefault(pid, now())
        else:
            rm.pop(pid, None)
        write_json(p_file("read.json"), rm)
    return {"id": pid, "read": pid in rm, "read_at": rm.get(pid)}


def api_today():
    posts = api_posts()
    try:
        dg = api_digest_today()
    except ApiError:
        dg = None
    return {"date": today_str(), "digest": dg, "total": len(posts), "unread": sum(1 for p in posts if not p["read"]),
            "review": review_today()}


class ApiError(Exception):
    def __init__(self, code, msg):
        self.code, self.msg = code, msg


def clean(s, n=5000):
    return (s or "").strip()[:n] if isinstance(s, str) else ""


# ---------- handlers ----------
def api_posts():
    posts = load_posts()
    posts.sort(key=lambda p: (not p.get("recommended"), -(p.get("metrics", {}).get("likes", 0))))
    hl = read_json(p_file("highlights.json"), [])
    nt = read_json(p_file("notes.json"), [])
    rm = read_map()
    for p in posts:
        p["themes"] = themes(p)
        p["read"] = p["id"] in rm
        p["read_at"] = rm.get(p["id"])
        p["highlight_count"] = sum(1 for h in hl if h["post_id"] == p["id"])
        p["note_count"] = sum(1 for n in nt if n["post_id"] == p["id"])
    return posts


def api_digest_today():
    ds = digests()
    if not ds:
        raise ApiError(404, "Sin digest todavía")
    today = dt.date.today().isoformat()
    d = next((x for x in ds if x["date"] == today), ds[0])
    post = get_post(d["post_id"])
    if post:
        post["themes"], post["read"] = themes(post), post["id"] in read_map()
    return dict(d, is_today=(d["date"] == today), post=post)


def create_highlight(b):
    p = get_post(b.get("post_id"))
    if not p:
        raise ApiError(404, "Post no existe")
    try:
        s, e = int(b["start"]), int(b["end"])
    except (KeyError, TypeError, ValueError):
        raise ApiError(400, "start/end inválidos")
    # offsets en unidades UTF-16 (igual que JavaScript), no en code points de Python
    t16 = p["text"].encode("utf-16-le", "surrogatepass")
    if not (0 <= s < e <= len(t16) // 2):
        raise ApiError(400, "Rango fuera del texto")
    try:
        frag = t16[2 * s:2 * e].decode("utf-16-le")
    except UnicodeDecodeError:
        raise ApiError(400, "Rango corta un carácter")
    if frag != b.get("text"):
        raise ApiError(400, "El texto no coincide con los offsets")
    with LOCK:
        hl = read_json(p_file("highlights.json"), [])
        dup = next((h for h in hl if h["post_id"] == p["id"] and h["start"] == s and h["end"] == e), None)
        if dup:
            return dup
        h = {"id": uuid.uuid4().hex[:12], "post_id": p["id"], "text": frag, "start": s, "end": e, "created_at": now()}
        hl.append(h)
        write_json(p_file("highlights.json"), hl)
    return h


def delete_highlight(hid):
    with LOCK:
        hl = read_json(p_file("highlights.json"), [])
        if not any(h["id"] == hid for h in hl):
            raise ApiError(404, "Subrayado no existe")
        write_json(p_file("highlights.json"), [h for h in hl if h["id"] != hid])
        notes = read_json(p_file("notes.json"), [])
        for n in notes:  # las notas se conservan, pierden el vínculo
            if n.get("highlight_id") == hid:
                n["highlight_id"] = None
                n["highlight_text"] = n.get("highlight_text") or ""
        write_json(p_file("notes.json"), notes)
        rv = review_state()
        if rv["items"].pop(hid, None) is not None:
            write_json(p_file("review.json"), rv)
    return {"ok": True}


def note_fields(b, base=None):
    n = dict(base or {})
    body, why = clean(b.get("body")), clean(b.get("why"), 1000)
    if "body" in b or not base:
        n["body"] = body
    if "why" in b or not base:
        n["why"] = why
    if not n.get("body") and not n.get("why"):
        raise ApiError(400, "La nota necesita texto o el motivo")
    return n


def create_note(b):
    p = get_post(b.get("post_id"))
    if not p:
        raise ApiError(404, "Post no existe")
    n = note_fields(b)
    with LOCK:
        hid, htext = b.get("highlight_id") or None, ""
        if hid:
            h = next((x for x in read_json(p_file("highlights.json"), []) if x["id"] == hid and x["post_id"] == p["id"]), None)
            if not h:
                raise ApiError(400, "Subrayado inválido")
            htext = h["text"]
        n.update({"id": uuid.uuid4().hex[:12], "post_id": p["id"], "highlight_id": hid, "highlight_text": htext,
                  "created_at": now(), "updated_at": now()})
        notes = read_json(p_file("notes.json"), [])
        notes.append(n)
        write_json(p_file("notes.json"), notes)
    return n


def update_note(nid, b):
    with LOCK:
        notes = read_json(p_file("notes.json"), [])
        n = next((x for x in notes if x["id"] == nid), None)
        if not n:
            raise ApiError(404, "Nota no existe")
        upd = note_fields(b, n)
        n.update(upd)
        n["updated_at"] = now()
        write_json(p_file("notes.json"), notes)
    return n


def delete_note(nid):
    with LOCK:
        notes = read_json(p_file("notes.json"), [])
        if not any(x["id"] == nid for x in notes):
            raise ApiError(404, "Nota no existe")
        write_json(p_file("notes.json"), [x for x in notes if x["id"] != nid])
    return {"ok": True}


class H(BaseHTTPRequestHandler):
    server_version = "LectorX/1.0"

    def log_message(self, fmt, *a):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % a))

    def send(self, code, body, ctype="application/json; charset=utf-8", cache="no-store"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 200_000:
            raise ApiError(413, "Cuerpo demasiado grande")
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "JSON inválido")

    def route(self, method):
        path = urlparse(self.path).path.rstrip("/") or "/"
        seg = path.split("/")
        if not path.startswith("/api/"):
            return self.static(path)
        res = None
        if method == "GET":
            if path == "/api/health":
                res = {"ok": True, "data": DATA}
            elif path == "/api/posts":
                res = api_posts()
            elif len(seg) == 4 and seg[2] == "posts":
                res = get_post(seg[3]) or self.fail(404, "Post no existe")
                res["themes"], res["read"] = themes(res), res["id"] in read_map()
            elif path == "/api/highlights":
                res = sorted(read_json(p_file("highlights.json"), []), key=lambda h: h["created_at"], reverse=True)
            elif path == "/api/notes":
                res = sorted(read_json(p_file("notes.json"), []), key=lambda n: n["created_at"], reverse=True)
            elif path == "/api/digest/today":
                res = api_digest_today()
            elif path == "/api/read":
                res = read_map()
            elif path == "/api/review/today":
                res = review_today()
            elif path == "/api/today":
                res = api_today()
        elif method == "POST":
            if path == "/api/highlights":
                return self.send(201, create_highlight(self.body()))
            if path == "/api/notes":
                return self.send(201, create_note(self.body()))
            if path == "/api/review":
                return self.send(200, post_review(self.body()))
            if len(seg) == 5 and seg[2] == "posts" and seg[4] == "read":
                return self.send(200, set_read(seg[3], self.body()))
        elif method == "PUT" and len(seg) == 4 and seg[2] == "notes":
            res = update_note(seg[3], self.body())
        elif method == "DELETE" and len(seg) == 4:
            if seg[2] == "highlights":
                res = delete_highlight(seg[3])
            elif seg[2] == "notes":
                res = delete_note(seg[3])
        if res is None:
            raise ApiError(404, "No encontrado")
        self.send(200, res)

    def fail(self, code, msg):
        raise ApiError(code, msg)

    def static(self, path):
        if path == "/":
            path = "/index.html"
        full = os.path.abspath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            full = os.path.join(STATIC, "index.html")  # fallback SPA
        with open(full, "rb") as f:
            self.send(200, f.read(), MIME.get(os.path.splitext(full)[1], "application/octet-stream"), "no-cache")

    def handle_any(self, method):
        try:
            self.route(method)
        except ApiError as e:
            self.send(e.code, {"error": e.msg})
        except Exception as e:  # noqa
            sys.stderr.write("ERROR %r\n" % (e,))
            self.send(500, {"error": "Error interno"})

    do_GET = lambda self: self.handle_any("GET")
    do_HEAD = lambda self: self.handle_any("GET")
    do_POST = lambda self: self.handle_any("POST")
    do_PUT = lambda self: self.handle_any("PUT")
    do_DELETE = lambda self: self.handle_any("DELETE")


def main():
    cfg = read_json(os.path.join(ROOT, "config.json"), {})
    port = int(os.environ.get("PORT") or cfg.get("port") or 8787)
    ThreadingHTTPServer.allow_reuse_address = True
    srv = ThreadingHTTPServer(("0.0.0.0", port), H)
    print(f"Lector X en http://0.0.0.0:{port}  datos: {DATA}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
