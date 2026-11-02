"""Score runs/*.jsonl: WER/CER, critical keys (names/terms/numbers/negations), latency, prompt leaks.

  python score.py            -> prints markdown tables (also runs/report.md)

Normalization (both ref and hyp): lowercase, ё->е, apostrophes dropped, punctuation/hyphens -> space,
number words -> digits (ru/uk, cardinal + ordinal, "двести пятьдесят тысяч" -> 250000, "150 000" -> 150000),
currency words/symbols canonicalized (рубля/руб/₽ -> руб, копеек/коп -> коп, гривень/грн -> грн),
and a fixed alias list mapping Cyrillic spellings of known terms to Latin (битрикс 24 -> bitrix24, кликап -> clickup).
Term accuracy is reported twice: strict = Latin spelling present before aliasing; lenient = after aliasing.
"""

import json
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"

ALIASES = [
    (r"\b(?:битрикс|бітрікс|бітрикс|битрiкс|bitrix)\s*24\b", "bitrix24"),
    (r"\b(?:битрикс|бітрікс|бітрикс)\b", "bitrix"),
    (r"\b(?:клик\s*ап|кликап|клікап|клік\s*ап|click\s*up)\b", "clickup"),
    (r"\b(?:амо|amo)\s*(?:crm|срм|црм|с[иі]\s*[аэе]р\s*[эе]м)\b", "amocrm"),
    (r"\b(?:кей|key)\s*(?:crm|срм|с[иі]\s*[аэе]р\s*[эе]м)\b", "keycrm"),
    (r"\b(?:срм|црм|с[иі]\s*[аэе]р\s*[эе]м)\b", "crm"),
    (r"\b(?:апи|апі|эйпиай|ейпіай|эй\s*пи\s*ай|ей\s*пі\s*ай|a\s*p\s*i)\b", "api"),
    (r"\b(?:вебхук\w*|веб\s*хук\w*|webhook\w*|web\s*hook\w*)\b", "webhook"),
    (r"\b(?:астериск\w*|астеріск\w*)\b", "asterisk"),
    (r"\b(?:бинотел\w*|бінотел\w*)\b", "binotel"),
    (r"\b(?:рингостат\w*|рінгостат\w*)\b", "ringostat"),
    (r"\b(?:сип|сіп)\b", "sip"),
    (r"\b(?:эс\s*эл\s*эй|ес\s*ел\s*ей|эсэлэй)\b", "sla"),
    (r"\bслак\w*\b", "slack"),
    (r"\bгугл\w*\b", "google"),
    (r"\b(?:шитс|шітс|шитз)\b", "sheets"),
]
ALIASES = [(re.compile(a), b) for a, b in ALIASES]

E = r"\w*"
NUM_WORDS = [  # (regex for the whole word, value, class)
    # teens / tens / hundreds first (more specific stems)
    (rf"одиннадцат{E}|одинадцят{E}", 11, "teen"), (rf"двенадцат{E}|дванадцят{E}", 12, "teen"),
    (rf"тринадцат{E}|тринадцят{E}", 13, "teen"), (rf"четырнадцат{E}|чотирнадцят{E}", 14, "teen"),
    (rf"пятнадцат{E}|пятнадцят{E}", 15, "teen"), (rf"шестнадцат{E}|шістнадцят{E}", 16, "teen"),
    (rf"семнадцат{E}|сімнадцят{E}", 17, "teen"), (rf"восемнадцат{E}|вісімнадцят{E}", 18, "teen"),
    (rf"девятнадцат{E}|девятнадцят{E}", 19, "teen"),
    (rf"десят(?:ь|и|ью|ый|ая|ое|ого|ому|ом|ой|ую|ий|а|е|ій|у|ьох|ьма)?", 10, "teen"),
    (rf"двадцат{E}|двадцят{E}", 20, "ten"), (rf"тридцат{E}|тридцят{E}", 30, "ten"),
    (r"сорок|сорока|сороков\w*", 40, "ten"),
    (rf"пятьдесят|пятидесят{E}|пятдесят{E}|пятдесяти", 50, "ten"),
    (rf"шестьдесят|шестидесят{E}|шістдесят{E}", 60, "ten"),
    (rf"семьдесят|семидесят{E}|сімдесят{E}", 70, "ten"),
    (rf"восемьдесят|восьмидесят{E}|вісімдесят{E}", 80, "ten"),
    (rf"девяносто|девяноста|девяност{E}", 90, "ten"),
    (r"сто|ста|сотн\w*|сот(?:ый|ая|ое|ого)", 100, "hundred"),
    (r"двести|двухсот\w*|двісті|двохсот\w*", 200, "hundred"),
    (r"триста|трехсот\w*|трьохсот\w*", 300, "hundred"),
    (r"четыреста|четырехсот\w*|чотириста|чотирьохсот\w*", 400, "hundred"),
    (r"пятьсот|пятисот\w*|пятсот|пятисот", 500, "hundred"),
    (r"шестьсот|шестисот\w*|шістсот|шестисот", 600, "hundred"),
    (r"семьсот|семисот\w*|сімсот|семисот", 700, "hundred"),
    (r"восемьсот|восьмисот\w*|вісімсот|восьмисот", 800, "hundred"),
    (r"девятьсот|девятисот\w*|девятсот", 900, "hundred"),
    # units, cardinal + ordinal forms
    (r"ноль|нол[яюе]|нуль|нул[яюе]", 0, "unit"),
    (r"од(?:ин|на|но|ного|ной|ну|ним|ном|ному|не|ній|нієї|ною)", 1, "unit"),
    (r"перв(?:ый|ая|ое|ого|ому|ом|ой|ую|ые)|перш(?:ий|а|е|ого|ому|ій|у|і)", 1, "unit"),
    (r"дв(?:а|е|ух|ум|умя|і|ох|ом|ома)", 2, "unit"),
    (r"втор(?:ой|ая|ое|ого|ому|ом|ую)|друг(?:ий|а|е|ого|ому|ій|у)", 2, "unit"),
    (r"тр(?:и|ех|ем|емя|ьох|ьом|ьома)", 3, "unit"),
    (r"трет(?:ий|ья|ье|ьего|ьему|ьем|ью|ій|я|є|ього|ьому|ю)", 3, "unit"),
    (r"четыр(?:е|ех|ем|ьмя)|чотир(?:и|ьох|ьом|ма)", 4, "unit"),
    (r"четверт(?:ый|ая|ое|ого|ому|ом|ой|ую|ий|а|е|ій|у)", 4, "unit"),
    (r"пят(?:ь|и|ью|ый|ая|ое|ого|ому|ом|ой|ую|ьох|ьом|ьма|ий|а|е|ій|у)", 5, "unit"),
    (r"шест(?:ь|и|ью|ой|ая|ое|ого|ому|ом|ую)|шіст(?:ь|и|ьох|ьма)|шост(?:ий|а|е|ого|ому|ій|у)", 6, "unit"),
    (r"сем(?:ь|и|ью|ох|ом|ома)|сім|седьм(?:ой|ая|ое|ого|ому|ом|ую)|сьом(?:ий|а|е|ого|ому|ій|у)", 7, "unit"),
    (r"вос(?:емь|ьми|емью)|вісім|вос(?:ьми|ьмох)|восьм(?:ой|ая|ое|ого|ому|ом|ую|ий|а|е|ій|у)", 8, "unit"),
    (r"девят(?:ь|и|ью|ый|ая|ое|ого|ому|ом|ой|ую|ьох|ьма|ий|а|е|ій|у)", 9, "unit"),
]
NUM_WORDS = [(re.compile(rf"^(?:{a})$"), v, c) for a, v, c in NUM_WORDS]
MULT = [(re.compile(r"^(?:тысяч\w*|тыщ\w*|тисяч\w*)$"), 1000), (re.compile(r"^(?:миллион\w*|мільйон\w*)$"), 10**6)]
FOLLOWS = {None: {"unit", "teen", "ten", "hundred"}, "hundred": {"unit", "teen", "ten"}, "ten": {"unit"},
           "mult": {"unit", "teen", "ten", "hundred"}}


def word_value(tok: str):
    if tok.isdigit():
        return int(tok), "digit"
    for rx, v in MULT:
        if rx.match(tok):
            return v, "mult"
    for rx, v, c in NUM_WORDS:
        if rx.match(tok):
            return v, c
    return None, None


def words_to_digits(tokens: list[str]) -> list[str]:
    out, total, cur, last, active = [], 0, 0, None, False

    def flush():
        nonlocal total, cur, last, active
        if active:
            out.append(str(total + cur))
        total, cur, last, active = 0, 0, None, False

    for tok in tokens:
        v, c = word_value(tok)
        if c is None:
            flush()
            out.append(tok)
        elif c == "mult":
            if not active:
                cur = 1
            total += cur * v
            cur, last, active = 0, "mult", True
        elif c == "digit":
            flush()
            cur, last, active = v, "digit", True
        else:
            if active and c not in FOLLOWS.get(last, set()):
                flush()
            cur += v
            last, active = c, True
    flush()
    return out


def normalize(text: str, alias: bool = True) -> str:
    s = text.lower().replace("ё", "е")
    s = re.sub(r"[’ʼ'`]", "", s)
    s = re.sub(r"(?<=\d)[\s  ](?=\d{3}\b)", "", s)
    s = s.replace("%", " процентов ")
    s = re.sub(r"(?<=[a-zа-яіїєґ])(?=\d)|(?<=\d)(?=[а-яіїєґ])", " ", s)  # битрикс24 -> битрикс 24
    s = s.replace("₽", " руб ")
    s = re.sub(r"[^\w\s]|_", " ", s)
    s = " ".join(words_to_digits(s.split()))
    s = re.sub(r"\bрубл\w*|\bруб\b", "руб", s)  # currency: form/abbreviation-insensitive
    s = re.sub(r"\bкопе\w*|\bкоп\b", "коп", s)
    s = re.sub(r"\bгрив\w*|\bгрн\b", "грн", s)
    if alias:
        for rx, rep in ALIASES:
            s = rx.sub(rep, s)
    return s


def edit_distance(a: list, b: list) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, y in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y))
        prev = cur
    return prev[-1]


def has(hyp: str, phrase: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(phrase)}(?!\w)", hyp) is not None


def key_ok(key: dict, hyp_norm: str, hyp_strict: str) -> tuple[bool, bool]:
    def ok(h):
        return any(has(h, normalize(a)) for a in key["any"]) and not any(has(h, normalize(n)) for n in key.get("not", []))
    return ok(hyp_norm), ok(hyp_strict)


def pct(x: float) -> str:
    return f"{100 * x:.1f}"


def quantile(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    if len(xs) == 1:
        return xs[0]
    k = (len(xs) - 1) * q
    lo = int(k)
    return xs[lo] + (xs[min(lo + 1, len(xs) - 1)] - xs[lo]) * (k - lo)


def load_med(rs: list[dict]) -> str:
    xs = [r["load1"] for r in rs if "load1" in r]
    return f"{statistics.median(xs):.0f}" if xs else "-"


def load_rows(glob: str = "*.jsonl") -> list[dict]:
    rows = []
    for f in sorted(RUNS.glob(glob)):
        rows += [json.loads(line) for line in f.read_text().splitlines() if line.strip()]
    return rows


def main() -> None:
    spec = json.loads((ROOT / "phrases.json").read_text())
    by_id = {p["id"]: p for p in spec["phrases"]}
    prompt_words = {lang: set(normalize(g).split()) for lang, g in spec["glossary"].items()}
    rows = [r for r in load_rows() if "id" in r and r["id"] in by_id]
    groups = defaultdict(list)
    for r in rows:
        groups[(r["tag"], r["lang"], r["cond"], r["prompt"])].append(r)
    lines = []
    out = lines.append

    out("### Quality: WER / CER / critical keys (%)\n")
    out("| run | lang | audio | prompt | n | WER | CER | WER no-term phrases | names | terms strict | terms lenient | numbers | negations | prompt-word insertions |")
    out("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for (tag, lang, cond, prompt), rs in sorted(groups.items()):
        we = wn = ce = cn = 0
        nte = ntn = 0
        keys = defaultdict(lambda: [0, 0])
        ins = 0
        for r in rs:
            p = by_id[r["id"]]
            ref, hyp = normalize(p["ref"]), normalize(r["text"])
            e = edit_distance(ref.split(), hyp.split())
            we += e
            wn += len(ref.split())
            if "term" not in p["tags"]:
                nte += e
                ntn += len(ref.split())
            ce += edit_distance(list(ref), list(hyp))
            cn += len(ref)
            hyp_strict = normalize(r["text"], alias=False)
            for k in p["keys"]:
                lenient, strict = key_ok(k, hyp, hyp_strict)
                if k["t"] == "term":
                    keys["term_s"][0] += strict
                    keys["term_s"][1] += 1
                    keys["term_l"][0] += lenient
                    keys["term_l"][1] += 1
                else:
                    keys[k["t"]][0] += lenient
                    keys[k["t"]][1] += 1
            pool = prompt_words.get(lang, set()) if prompt != "overload" else set()
            if prompt == "overload":
                from bench import OVERLOAD_PROMPT  # noqa: PLC0415
                pool = set(normalize(OVERLOAD_PROMPT[lang]).split())
            leaked = (set(hyp.split()) & pool) - set(ref.split()) - {"и", "в", "з", "і", "та"}
            ins += bool(leaked)

        def k(name):
            a, b = keys[name]
            return f"{pct(a / b)} ({a}/{b})" if b else "-"
        out(f"| {tag} | {lang} | {cond} | {prompt} | {len(rs)} | {pct(we / wn)} | {pct(ce / cn)} | {pct(nte / ntn)} | {k('name')} | "
            f"{k('term_s')} | {k('term_l')} | {k('number')} | {k('negation')} | {ins}/{len(rs)} |")

    out("\n### Latency (warm model, wall-clock per phrase, s) and RTF\n")
    out("| run | audio | prompt | lang | n | p50 | p95 | max | RTF p50 | RTF Σ | p50 <4s | p50 4-7s | p50 >7s | sys load1 p50 |")
    out("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    lat = defaultdict(list)
    for r in rows:
        lat[(r["tag"], r["cond"], r["prompt"], r["lang"])].append(r)
        lat[(r["tag"], r["cond"], r["prompt"], "all")].append(r)
    for (tag, cond, prompt, lang), rs in sorted(lat.items()):
        ls = [r["latency_s"] for r in rs]
        rt = [r["rtf"] for r in rs]

        def bucket(lo, hi):
            b = [r["latency_s"] for r in rs if lo <= r["dur_s"] < hi]
            return f"{statistics.median(b):.2f}" if b else "-"
        out(f"| {tag} | {cond} | {prompt} | {lang} | {len(rs)} | {quantile(ls, .5):.2f} | {quantile(ls, .95):.2f} | "
            f"{max(ls):.2f} | {quantile(rt, .5):.3f} | {sum(ls) / sum(r["dur_s"] for r in rs):.3f} | {bucket(0, 4)} | {bucket(4, 7)} | {bucket(7, 99)} | {load_med(rs)} |")

    out("\n### Latency at low background load (requests with 1-min load avg <= 8; call audio)\n")
    out("| run | prompt | n | p50 | p95 | max | RTF Σ |")
    out("|---|---|---|---|---|---|---|")
    quiet = defaultdict(list)
    for r in rows:
        if r.get("load1") is not None and r["load1"] <= 8 and r["cond"] == "call":
            quiet[(r["tag"], r["prompt"])].append(r)
    for (tag, prompt), rs in sorted(quiet.items()):
        if len(rs) < 10:
            continue
        ls = [r["latency_s"] for r in rs]
        out(f"| {tag} | {prompt} | {len(rs)} | {quantile(ls, .5):.2f} | {quantile(ls, .95):.2f} | {max(ls):.2f} | "
            f"{sum(ls) / sum(r['dur_s'] for r in rs):.3f} |")

    out("\n### Drift over a run (thermal): median latency of first vs last 20 requests\n")
    out("| run | pace | first 20 p50 | last 20 p50 | run length s |")
    out("|---|---|---|---|---|")
    by_tag = defaultdict(list)
    for r in rows:
        if "t_s" in r:
            by_tag[r["tag"]].append(r)
    for tag, rs in sorted(by_tag.items()):
        rs.sort(key=lambda r: r["t_s"])
        if len(rs) >= 40:
            meta_f = RUNS / f"{tag}.meta.json"
            pace = json.loads(meta_f.read_text()).get("pace", "-") if meta_f.exists() else "-"
            out(f"| {tag} | {pace} | {statistics.median(r['latency_s'] for r in rs[:20]):.2f} | "
                f"{statistics.median(r['latency_s'] for r in rs[-20:]):.2f} | {rs[-1]['t_s']:.0f} |")

    out("\n### Model load / memory\n")
    out("| run | model MB | load s | peak RSS MB | peak footprint MB | threads | GPU |")
    out("|---|---|---|---|---|---|---|")
    for f in sorted(RUNS.glob("*.meta.json")):
        m = json.loads(f.read_text())
        out(f"| {m['tag']} | {m['model_mb']} | {m['load_s']} | {m['peak_rss_mb']} | {m.get('peak_footprint_mb', '-')} | "
            f"{m['threads']} | {'no' if m['no_gpu'] else 'yes'} |")

    out("\n### Hallucinations on no-speech clips (5 clips x ru/uk x 2 repeats = 20 per cell)\n")
    out("| model | config | non-empty raw | non-empty after app filter | examples (raw) |")
    out("|---|---|---|---|---|")
    hal = defaultdict(list)
    for f in sorted(RUNS.glob("halluc-*.jsonl")):
        for line in f.read_text().splitlines():
            r = json.loads(line)
            hal[(r["tag"], r["config"])].append(r)
    for (tag, cfg), rs in hal.items():
        raw = [r for r in rs if r["text"].strip()]
        filt = [r for r in rs if r["filtered"].strip()]
        ex = sorted({r["text"][:60] for r in raw})[:3]
        out(f"| {tag} | {cfg} | {len(raw)}/{len(rs)} | {len(filt)}/{len(rs)} | {' / '.join(ex)} |")
    for f in sorted(RUNS.glob("*gigaam*.meta.json")):
        m = json.loads(f.read_text())
        sil = [x for x in m.get("silence", []) if x["text"].strip()]
        out(f"| {m['tag']} | (no filter) | {len(sil)}/{len(m.get('silence', []))} | - | {' / '.join(x['text'][:40] for x in sil)} |")

    report = "\n".join(lines)
    (RUNS / "report.md").write_text(report)
    print(report)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--norm":
        print(normalize(" ".join(sys.argv[2:])))
    else:
        main()
