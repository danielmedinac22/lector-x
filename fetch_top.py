#!/usr/bin/env python3
"""Lector X - fetch_top.py

Las herramientas de lectura de X (namespace MCP `x`) solo las puede llamar el
agente, no un script de Shell. Este script imprime EXACTAMENTE los parámetros que
el agente debe pasar a `search_posts_all` según config.json (solo lectura), y la
línea de comando de ingest a ejecutar después.

  python3 fetch_top.py            # imprime JSON con los argumentos de la llamada
"""
import datetime as dt, json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
cfg = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
f = cfg["fetch"]
start = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=f["lookback_hours"])).strftime("%Y-%m-%dT%H:%M:%SZ")
today = dt.date.today().isoformat()
print(json.dumps({
    "tool": "x.search_posts_all (solo lectura)",
    "arguments": {
        "query": f["query"], "start_time": start, "sort_order": f["sort_order"],
        "max_results": f["max_results"], "post.fields": f["post_fields"],
        "expansions": f["expansions"], "user.fields": f["user_fields"],
    },
    "save_raw_to": f"{ROOT}/raw/search-{today}-1.json",
    "then_run": f"python3 {ROOT}/ingest.py '{ROOT}/raw/*{today}*.json' [--pick ID --why '2-4 líneas']",
    "note": "El operador min_likes: NO es aplicado por la herramienta; ingest.py filtra localmente con config.filter.",
}, ensure_ascii=False, indent=2))
