#!/usr/bin/env python3
"""Writes a few hundred broken, odd and hostile subtitle files into a folder, for fuzz.js / fuzz.lua / FuzzWords.cs.
    python3 bench/fuzz/make_cases.py OUTDIR [N_RANDOM]
Hand-written edge cases first (named), then random mutations of the sample subtitles (seeded, so runs repeat)."""
import os, random, sys, glob

out = sys.argv[1]; nrand = int(sys.argv[2]) if len(sys.argv) > 2 else 400
os.makedirs(out, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
samples = [open(p, "rb").read() for p in sorted(glob.glob(os.path.join(ROOT, "vlc/test/samples/*.srt")))]
n = 0
def put(name, data):
    global n
    if isinstance(data, str): data = data.encode("utf-8")
    open(os.path.join(out, f"{n:04d}_{name}"), "wb").write(data); n += 1

def srt(*cues, sep="\n"):
    return sep.join(f"{i+1}{sep}{a} --> {b}{sep}{t}{sep}" for i, (a, b, t) in enumerate(cues))

A, B = "00:00:01,000", "00:00:03,000"
put("empty.srt", "")
put("bom_only.srt", "﻿")
put("whitespace.srt", " \n\n\t\r\n ")
put("crlf.srt", srt((A, B, "Hello there."), sep="\r\n"))
put("cr_only.srt", srt((A, B, "Hello there."), sep="\r"))
put("no_blank_lines.srt", "1\n00:00:01,000 --> 00:00:02,000\nOne\n2\n00:00:02,000 --> 00:00:03,000\nTwo\n")
put("end_before_start.srt", srt(("00:00:05,000", "00:00:02,000", "Backwards time.")))
put("zero_length.srt", srt((A, A, "Instant line here.")))
put("huge_time.srt", srt(("99:59:59,999", "99:59:59,999", "End of time"), ("00:00:01,000", "999:00:00,000", "Too long")))
put("short_ms.srt", srt(("00:00:01,5", "00:00:02,25", "Odd millis")))
put("dot_sep.srt", srt(("00:00:01.000", "00:00:02.000", "Dots not commas")))
put("no_hours.srt", srt(("00:01,000", "00:02,000", "No hours")))
put("garbage_times.srt", srt(("aa:bb:cc,ddd", "00:00:02,000", "Bad start")))
put("overlap.srt", srt(("00:00:01,000", "00:00:05,000", "First long line"), ("00:00:02,000", "00:00:03,000", "Inside it"), ("00:00:02,500", "00:00:04,000", "And another")))
put("same_time_many.srt", srt(*[(A, B, f"Row {i}") for i in range(50)]))
put("thousand_cues.srt", srt(*[(f"00:{i//60:02d}:{i%60:02d},000", f"00:{i//60:02d}:{i%60:02d},900", "word " * (i % 7 + 1)) for i in range(1000)]))
put("long_cue.srt", srt((A, B, " ".join(["word"] * 2000))))
put("giant_line.srt", srt((A, B, "x" * 100000)))
put("one_char_words.srt", srt((A, B, " ".join("abcdefghijklmnopqrstuvwxyz" * 20))))
put("tags.srt", srt((A, B, "<i><b>Unclosed <font color='#fff'>tags <u>everywhere"), (B, "00:00:04,000", "</i></b></font> closing only")))
put("ass_tags.srt", srt((A, B, "{\\an8}{\\pos(10,10)}Top {\\i1}line{\\i0} {")))
put("braces_backslash.srt", srt((A, B, "a \\N b {c} \\h d \\\\ e }{")))
put("music_only.srt", srt((A, B, "♪ ♪ ♪"), (B, "00:00:04,000", "♪")))
put("punct_only.srt", srt((A, B, "... -- !!! ??? ,,, ''")))
put("dashes.srt", srt((A, B, "- \n- \n-")))
put("entities.srt", srt((A, B, "&amp;&lt;&gt;&quot;&#39;&#x1F600;&nbsp;&bogus; &#99999999;")))
put("emoji.srt", srt((A, B, "😀 👍🏽 👨‍👩‍👧 🇮🇳 ok")))
put("rtl.srt", srt((A, B, "مرحبا كيف حالك؟ שלום")))
put("cjk.srt", srt((A, B, "我们今天去哪里吃饭？東京に行きます。안녕하세요")))
put("hindi.srt", srt((A, B, "मुझे नहीं पता। क्या हुआ?")))
put("zalgo.srt", srt((A, B, "Ẑ̵̡͎a̷l̶g̴o̸ ̷t̵e̵x̶t̷")))
put("nul_bytes.srt", srt((A, B, "nul\x00in\x00text")))
put("control_chars.srt", srt((A, B, "".join(chr(i) for i in range(1, 32) if i not in (10, 13)) + "ok")))
put("invalid_utf8.srt", b"1\n00:00:01,000 --> 00:00:02,000\n\xff\xfe\xc3\x28 bad \xe2\x82 bytes \xf0\x9f\n")
put("latin1.srt", "1\n00:00:01,000 --> 00:00:02,000\nCafé déjà vu, señor\n".encode("latin-1"))
put("utf16le.srt", "﻿" + srt((A, B, "UTF sixteen LE")), )
open(os.path.join(out, f"{n-1:04d}_utf16le.srt"), "wb").write(("﻿" + srt((A, B, "UTF sixteen LE"))).encode("utf-16-le"))
put("utf16be.srt", ("﻿" + srt((A, B, "UTF sixteen BE"))).encode("utf-16-be"))
put("utf16_odd_length.srt", ("﻿" + srt((A, B, "odd"))).encode("utf-16-le") + b"\x41")
put("no_text.srt", "1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:02,000 --> 00:00:03,000\n\n")
put("index_only.srt", "1\n2\n3\n")
put("arrow_in_text.srt", srt((A, B, "this --> that 00:00:09,000 --> 00:00:10,000")))
put("vtt_basic.vtt", "WEBVTT\n\n00:01.000 --> 00:03.000 align:start position:10%\nHello <v Bob>there</v>.\n")
put("vtt_blocks.vtt", "WEBVTT - title\nKind: captions\n\nSTYLE\n::cue { color: red }\n\nNOTE a note\nwith lines\n\nREGION\nid:fred\n\nid1\n00:00:01.000 --> 00:00:02.000 region:fred\n<c.yellow>Hi</c> <00:00:01.500>karaoke\n")
put("vtt_no_cues.vtt", "WEBVTT\n\n")
put("vtt_bad.vtt", "WEBVTT\n00:01.000 -> 00:03.000\nnot an arrow\n\n--> \n\n00:00:01.000 -->\n")
put("ttml_basic.ttml", '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.000" end="00:00:02.000">Hello<br/>there</p><p begin="2s" end="3.5s">Seconds form</p></div></body></tt>')
put("ttml_ticks.ttml", '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000"><body><div><p begin="10000000t" end="20000000t">Ticks</p><p begin="00:00:02:12" end="00:00:03:00">Frames</p></div></body></tt>')
put("ttml_ns.ttml", '<tt:tt xmlns:tt="http://www.w3.org/ns/ttml"><tt:body><tt:div><tt:p begin="00:00:01.000" end="00:00:02.000"><tt:span>Prefixed</tt:span></tt:p></tt:div></tt:body></tt:tt>')
put("ttml_broken.ttml", '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.000" end="00:00:02.000">Unclosed <span>tag</p><p begin="x" end="y">bad</p>')
put("ttml_bomb.ttml", '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="2s">&lol3;</p></div></body></tt>')
put("json3_basic.json", '{"events":[{"tStartMs":1000,"dDurationMs":2000,"segs":[{"utf8":"Hello "},{"utf8":"there"}]},{"tStartMs":3000}]}')
put("json3_bad.json", '{"events":[{"tStartMs":"x","dDurationMs":-5,"segs":null},{"segs":[{}]},null,5]}')
put("json3_truncated.json", '{"events":[{"tStartMs":1000,"dDurationMs":2000,"segs":[{"utf8":"Hel')
put("srv3_basic.xml", '<?xml version="1.0"?><timedtext format="3"><body><p t="1000" d="2000">Hello <s>there</s></p><p t="x" d="y">bad</p></body></timedtext>')

rnd = random.Random(int(os.environ.get("FUZZ_SEED", "20261009")))
def mutate(b):
    b = bytearray(b)
    for _ in range(rnd.randint(1, 12)):
        op = rnd.random()
        if not b: b.extend(b"1\n"); continue
        i = rnd.randrange(len(b))
        if op < 0.25: b[i] = rnd.randrange(256)
        elif op < 0.45: del b[i:i + rnd.randint(1, 40)]
        elif op < 0.6: j = rnd.randrange(len(b)); b[i:i] = b[j:j + rnd.randint(1, 200)]
        elif op < 0.75: b[i:i] = rnd.choice([b"-->", b"\n\n", b"\r", b":", b",", b"<i>", b"{", b"\\", b"99", b"\x00", b"\xff", b"\xe2\x99\xaa", b"&#", b"<"])
        elif op < 0.9:  # replace a digit run with something extreme
            j = i
            while j < len(b) and 48 <= b[j] <= 57: j += 1
            b[i:j] = rnd.choice([b"0", b"999999999", b"-1", b"", b"00"])
        else: b = b[:i]  # truncate
    return bytes(b)
for k in range(nrand):
    src = rnd.choice(samples)
    put(f"mut{k}.srt", mutate(src))
print(n, "cases in", out)
