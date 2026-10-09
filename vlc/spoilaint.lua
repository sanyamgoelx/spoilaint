--[[
 Spoilaint for VLC: spoiler-free subtitles, words appear as they are spoken.

 How it runs: this is a VLC "interface" script. The Spoilaint installer copies it to
   %APPDATA%\vlc\lua\intf\spoilaint.lua
 and adds two lines to %APPDATA%\vlc\vlcrc so VLC starts it by itself:
   extraintf=luaintf
   lua-intf=spoilaint

 Whenever you open a movie it:
   1. finds the subtitle file next to it (Movie.srt, Movie.en.srt, Subs\English.srt ...),
      or pulls the text subtitles out of the .mkv with ffmpeg if there's no file,
   2. writes a word-by-word version (.ass) into VLC's cache folder,
   3. loads it and switches to it. VLC's own subtitle delay keys (G / H) still work.

 Settings live in %APPDATA%\vlc\spoilaint.ini (written by the installer):
   mode=word        word | chunk | off
   lag=0            ms; 0 = on time. Lines not checked against speech get +300 ms extra by themselves
   theme=amber      amber | dark | indigo | green (colour of the newest word)
   highlight=1      1 = colour the newest word
   size=64          font size on a 1080p frame
   box=0            1 = dark box behind the text
   font=Segoe UI
   ffmpeg=          full path to ffmpeg.exe (blank = look on PATH)

 The timing part is a port of engine/spoilaint-engine.js. Keep them in sync.
]]

local SETTINGS = {
  mode = "word", lag = 0, theme = "amber", highlight = true,
  size = 64, box = false, font = "Segoe UI", ffmpeg = ""
}
local THEMES = { amber = "#FFB23F", dark = "#E4E0D9", indigo = "#8C9BFF", green = "#5FD892" }
local TUNING = {
  unitMaxMs = 250, fill = 0.9, chunkSize = 3, maxSteps = 60,
  pauseEllipsis = 2.0, pauseStop = 1.2, pauseComma = 0.8, pauseLineBreak = 0.4,
  noLetterWeight = 0.25,
  holdMs = 800  -- a line stays up until its last word has been on screen this long (may overlap the next line)
}

local IS_WINDOWS = package.config:sub(1, 1) == "\\"
local SEP = IS_WINDOWS and "\\" or "/"
-- Paths handed to the Spoilaint app use the system's separator.
local function nativePath(p) if IS_WINDOWS then return (p:gsub("/", "\\")) end return p end

-- Log to VLC's messages window (Tools > Messages) and to %APPDATA%\vlc\spoilaint.log.
local logFile
local function log(msg)
  if vlc and vlc.msg then vlc.msg.info("[spoilaint] " .. msg) else print("[spoilaint] " .. msg) end
  if logFile then
    pcall(function() logFile:write(os.date("%H:%M:%S") .. "  " .. msg .. "\r\n"); logFile:flush() end)
  end
end

-------------------------------------------------------------------------------
-- UTF-8 helpers
-------------------------------------------------------------------------------
local function codepoints(s)
  local out, i, n = {}, 1, #s
  while i <= n do
    local c = s:byte(i)
    local cp, len
    if c < 0x80 then cp, len = c, 1
    elseif c >= 0xF0 and i + 3 <= n then
      cp = (c - 0xF0) * 262144 + (s:byte(i + 1) - 0x80) * 4096 + (s:byte(i + 2) - 0x80) * 64 + (s:byte(i + 3) - 0x80); len = 4
    elseif c >= 0xE0 and i + 2 <= n then
      cp = (c - 0xE0) * 4096 + (s:byte(i + 1) - 0x80) * 64 + (s:byte(i + 2) - 0x80); len = 3
    elseif c >= 0xC0 and i + 1 <= n then
      cp = (c - 0xC0) * 64 + (s:byte(i + 1) - 0x80); len = 2
    else cp, len = 0xFFFD, 1 end
    out[#out + 1] = cp
    i = i + len
  end
  return out
end

local function utf8char(cp)
  if cp < 0x80 then return string.char(cp)
  elseif cp < 0x800 then return string.char(0xC0 + math.floor(cp / 64), 0x80 + cp % 64)
  elseif cp < 0x10000 then
    return string.char(0xE0 + math.floor(cp / 4096), 0x80 + math.floor(cp / 64) % 64, 0x80 + cp % 64)
  else
    return string.char(0xF0 + math.floor(cp / 262144), 0x80 + math.floor(cp / 4096) % 64,
      0x80 + math.floor(cp / 64) % 64, 0x80 + cp % 64)
  end
end

local function isValidUTF8(s)
  local i, n = 1, #s
  while i <= n do
    local c = s:byte(i)
    local len
    if c < 0x80 then len = 1
    elseif c >= 0xC2 and c <= 0xDF then len = 2
    elseif c >= 0xE0 and c <= 0xEF then len = 3
    elseif c >= 0xF0 and c <= 0xF4 then len = 4
    else return false end
    for k = 1, len - 1 do
      local d = s:byte(i + k)
      if not d or d < 0x80 or d > 0xBF then return false end
    end
    i = i + len
  end
  return true
end

local CP1252 = { [0x80]=0x20AC,[0x82]=0x201A,[0x83]=0x0192,[0x84]=0x201E,[0x85]=0x2026,[0x86]=0x2020,[0x87]=0x2021,
  [0x88]=0x02C6,[0x89]=0x2030,[0x8A]=0x0160,[0x8B]=0x2039,[0x8C]=0x0152,[0x8E]=0x017D,[0x91]=0x2018,[0x92]=0x2019,
  [0x93]=0x201C,[0x94]=0x201D,[0x95]=0x2022,[0x96]=0x2013,[0x97]=0x2014,[0x98]=0x02DC,[0x99]=0x2122,[0x9A]=0x0161,
  [0x9B]=0x203A,[0x9C]=0x0153,[0x9E]=0x017E,[0x9F]=0x0178 }

local function fromUTF16(s, bigEndian)
  local out, i = {}, 1
  while i + 1 <= #s do
    local a, b = s:byte(i), s:byte(i + 1)
    local u = bigEndian and (a * 256 + b) or (b * 256 + a)
    i = i + 2
    if u >= 0xD800 and u <= 0xDBFF and i + 1 <= #s then
      local c, d = s:byte(i), s:byte(i + 1)
      local lo = bigEndian and (c * 256 + d) or (d * 256 + c)
      if lo >= 0xDC00 and lo <= 0xDFFF then u = 0x10000 + (u - 0xD800) * 1024 + (lo - 0xDC00); i = i + 2 end
    end
    out[#out + 1] = utf8char(u)
  end
  return table.concat(out)
end

-- Any subtitle file bytes -> UTF-8 text.
local function toUTF8(s)
  if s:sub(1, 3) == "\239\187\191" then return s:sub(4) end
  if s:sub(1, 2) == "\255\254" then return fromUTF16(s:sub(3), false) end
  if s:sub(1, 2) == "\254\255" then return fromUTF16(s:sub(3), true) end
  if isValidUTF8(s) then return s end
  local out = {}
  for i = 1, #s do
    local c = s:byte(i)
    if c < 0x80 then out[#out + 1] = string.char(c)
    else out[#out + 1] = utf8char(CP1252[c] or c) end
  end
  return table.concat(out)
end

-------------------------------------------------------------------------------
-- Character classes and weights (same as the JS engine)
-------------------------------------------------------------------------------
local function isLatin(cp)
  return (cp >= 65 and cp <= 90) or (cp >= 97 and cp <= 122) or
    (cp >= 0xC0 and cp <= 0x24F and cp ~= 0xD7 and cp ~= 0xF7)
end
local function isDigit(cp) return cp >= 48 and cp <= 57 end
local function isDevanagari(cp) return cp >= 0x900 and cp <= 0x97F and cp ~= 0x964 and cp ~= 0x965 end
local function isCJK(cp)
  return (cp >= 0x3040 and cp <= 0x30FF) or (cp >= 0x3400 and cp <= 0x9FFF) or (cp >= 0xAC00 and cp <= 0xD7AF)
end
local function isOtherLetter(cp)
  if cp < 0x370 then return false end
  if cp >= 0x2000 and cp <= 0x2BFF then return false end
  if cp >= 0x3000 and cp <= 0x303F then return false end
  if cp >= 0xFE30 and cp <= 0xFE4F then return false end
  if cp >= 0xFF00 and cp <= 0xFF0F then return false end
  if cp >= 0x1F000 then return false end
  return not (cp >= 0x900 and cp <= 0x97F)
end
local function isWordChar(cp) return isLatin(cp) or isDigit(cp) or isDevanagari(cp) or isOtherLetter(cp) end

local VOWELS = {}
for _, cp in ipairs(codepoints("aeiouyAEIOUYàáâãäåæèéêëìíîïòóôõöøùúûüýÿÀÁÂÃÄÅÆÈÉÊËÌÍÎÏÒÓÔÕÖØÙÚÛÜÝ")) do VOWELS[cp] = true end

local function weightOf(token)
  local cps = codepoints(token)
  local latinGroups, inVowel, latinLetters, latinTail = 0, false, 0, ""
  local digits, deva, devaVirama, hasDeva, cjk, other, letters = 0, 0, 0, false, 0, 0, 0
  for _, cp in ipairs(cps) do
    if isLatin(cp) then
      letters = letters + 1; latinLetters = latinLetters + 1
      latinTail = (latinTail .. (cp < 128 and string.char(cp) or "x")):sub(-3)
      if VOWELS[cp] then
        if not inVowel then latinGroups = latinGroups + 1 end
        inVowel = true
      else inVowel = false end
    else
      inVowel = false
      if isDigit(cp) then digits = digits + 1; letters = letters + 1
      elseif isDevanagari(cp) then
        hasDeva = true; letters = letters + 1
        if (cp >= 0x915 and cp <= 0x939) or (cp >= 0x958 and cp <= 0x95F) or (cp >= 0x904 and cp <= 0x914) then deva = deva + 1
        elseif cp == 0x94D then devaVirama = devaVirama + 1 end
      elseif isCJK(cp) then cjk = cjk + 1; letters = letters + 1
      elseif isOtherLetter(cp) then other = other + 1; letters = letters + 1 end
    end
  end
  if latinLetters > 3 and latinGroups > 1 then
    local tail = latinTail:lower()
    if tail:match("[^aeiouy]e$") and not tail:match("le$") then latinGroups = latinGroups - 1
    elseif tail:match("[^aeiouytd]ed$") then latinGroups = latinGroups - 1 end
  end
  if latinLetters > 0 and latinGroups == 0 then latinGroups = 1 end
  local w = latinGroups + digits + cjk + math.ceil(other / 3)
  if hasDeva then w = w + math.max(1, deva - devaVirama) end
  if letters == 0 then return TUNING.noLetterWeight end
  return math.max(1, w)
end

local function endsWith(s, suffix) return suffix == "" or s:sub(-#suffix) == suffix end

local CLOSERS = { '"', "'", "\226\128\157", "\226\128\153", ")", "]", "\194\187" } -- " ' ” ’ ) ] »
local function pauseAfter(token, br)
  local t = token
  local changed = true
  while changed do
    changed = false
    for _, c in ipairs(CLOSERS) do
      if #t > #c and endsWith(t, c) then t = t:sub(1, -#c - 1); changed = true end
    end
  end
  if endsWith(t, "...") or endsWith(t, "\226\128\166") then return TUNING.pauseEllipsis end
  if t:match("[%.!%?]$") or endsWith(t, "\224\165\164") or endsWith(t, "\224\165\165") then return TUNING.pauseStop end
  if t:match("[,;:]$") or endsWith(t, "\226\128\148") or endsWith(t, "\226\128\147") or endsWith(t, "--") then
    return TUNING.pauseComma
  end
  if br then return TUNING.pauseLineBreak end
  return 0
end

local function hasWordChar(s)
  for _, cp in ipairs(codepoints(s)) do if isWordChar(cp) then return true end end
  return false
end

-------------------------------------------------------------------------------
-- Text cleaning and tokenizing
-------------------------------------------------------------------------------
local ENTITIES = { amp = "&", lt = "<", gt = ">", quot = '"', apos = "'", nbsp = " " }
local function decodeEntities(s)
  return (s:gsub("&(#?[xX]?%w+);", function(e)
    if e:sub(1, 1) == "#" then
      local n
      if e:sub(2, 2) == "x" or e:sub(2, 2) == "X" then n = tonumber(e:sub(3), 16) else n = tonumber(e:sub(2)) end
      if n and n > 0 and n <= 0x10FFFF and (n < 0xD800 or n > 0xDFFF) then return utf8char(n) end
      return "&" .. e .. ";"
    end
    return ENTITIES[e] or ("&" .. e .. ";")
  end))
end

local function trim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end

local function cleanText(s)
  s = s:gsub("\r", "")
  s = s:gsub("<[bB][rR]%s*/?>", "\n")
  s = s:gsub("{\\[^}]*}", "")
  s = s:gsub("<[^>]+>", "")
  s = decodeEntities(s)
  s = s:gsub("\194\160", " "):gsub("\\N", "\n")
  local lines = {}
  for line in (s .. "\n"):gmatch("([^\n]*)\n") do
    line = trim(line:gsub("[ \t]+", " "))
    if #line > 0 then lines[#lines + 1] = line end
  end
  return table.concat(lines, "\n")
end

-- text -> words {text, br}
-- Helper text: [door creaks], (laughs), JOHN:  (same rules as markInstant in the JS engine)
-- Sound descriptions and speaker labels aren't speech: they appear at once, take no speaking time
-- and are never coloured as the newest word.
local function stripLead(t)
  local changed = true
  while changed do
    changed = false
    for _, lead in ipairs({ " ", "\t", "-", "\226\128\147", "\226\128\148", "\226\153\170", "\226\153\171" }) do
      if #t > 0 and t:sub(1, #lead) == lead then t = t:sub(#lead + 1); changed = true end
    end
  end
  return t
end
local function markInstant(words)
  local depth = 0
  for i, w in ipairs(words) do
    local core = stripLead(w.text)
    local inst = depth > 0 or core:match("^[%[%(]") ~= nil
    local _, opens = w.text:gsub("[%[%(]", "")
    local _, closes = w.text:gsub("[%]%)]", "")
    depth = math.max(0, depth + opens - closes)
    local lineStart = i == 1 or words[i - 1].br
    local plain = core:gsub("\226\128\153", "'")
    if lineStart and #core >= 3 and core:match("[A-Z]") and plain:match("^[A-Z0-9][A-Z0-9 %.'&%-]*:$") then inst = true end
    w.inst = inst
  end
  return words
end
-- Helper text appears together with the spoken word before it (or when the line appears).
local function placeInstant(words, start)
  local last = start
  for _, w in ipairs(words) do
    if w.inst then w.at = last else last = w.at end
  end
  return words
end

-- text -> words {text, br, inst}
local function tokenize(text)
  local out = {}
  local lineList = {}
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do lineList[#lineList + 1] = line end
  for li, lineText in ipairs(lineList) do
    local line, pending = {}, nil
    for part in lineText:gmatch("[^ \t]+") do
      if not hasWordChar(part) then
        pending = pending and (pending .. " " .. part) or part
      else
        line[#line + 1] = { text = pending and (pending .. " " .. part) or part, br = false }
        pending = nil
      end
    end
    if pending then
      if #line > 0 then line[#line].text = line[#line].text .. " " .. pending
      else line[#line + 1] = { text = pending, br = false } end
    end
    if #line > 0 and li < #lineList then line[#line].br = true end
    for _, w in ipairs(line) do out[#out + 1] = w end
  end
  if #out > 0 then out[#out].br = false end
  return markInstant(out)
end

-------------------------------------------------------------------------------
-- Parsing
-------------------------------------------------------------------------------
local function clockToMs(s)
  s = trim(s)
  local h, m, sec, sep, frac = s:match("^(%d+):(%d%d?):(%d%d?)([%.,]?)(%d*)$")
  if not h then
    m, sec, sep, frac = s:match("^(%d%d?):(%d%d?)([%.,]?)(%d*)$")
    h = "0"
  end
  if not m or #h > 2 or (#frac > 0 and sep == "") then return nil end  -- 100+ hours: a broken time, not a film
  local ms = 0
  if frac and #frac > 0 then ms = tonumber((frac .. "00"):sub(1, 3)) end
  return ((tonumber(h) * 60 + tonumber(m)) * 60 + tonumber(sec)) * 1000 + ms
end

local function splitBlocks(text)
  text = text:gsub("\r\n?", "\n")
  local blocks, cur = {}, {}
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    if line:match("^[ \t]*$") then
      if #cur > 0 then blocks[#blocks + 1] = cur; cur = {} end
    else cur[#cur + 1] = line end
  end
  if #cur > 0 then blocks[#blocks + 1] = cur end
  return blocks
end

-- SRT and WebVTT (sidecar files). Returns cues {start, end, text}.
-- Lines that appear and disappear together are one subtitle on two rows: join them, top row first.
local MERGE_MS = 40
local function mergeSameTime(cues)
  local out, group = {}, {}
  local function flush()
    if #group == 0 then return end
    if #group == 1 then out[#out + 1] = group[1]; group = {}; return end
    table.sort(group, function(a, b)
      if a.y ~= b.y then return a.y < b.y end
      return a.idx < b.idx
    end)
    local m = { start = group[1].start, ["end"] = group[1]["end"], y = group[1].y, idx = group[1].idx }
    local texts = {}
    for _, c in ipairs(group) do
      m.start = math.min(m.start, c.start); m["end"] = math.max(m["end"], c["end"])
      texts[#texts + 1] = c.text
    end
    m.text = table.concat(texts, "\n")
    out[#out + 1] = m
    group = {}
  end
  for _, c in ipairs(cues) do
    if #group > 0 and not (math.abs(group[1].start - c.start) <= MERGE_MS and math.abs(group[1]["end"] - c["end"]) <= MERGE_MS) then flush() end
    group[#group + 1] = c
  end
  flush()
  return out
end

-- SRT and WebVTT (sidecar files). Returns cues {start, end, text}.
local function parseSubs(text)
  local cues = {}
  for _, lines in ipairs(splitBlocks(text)) do
    local i = 1
    while i <= #lines and not lines[i]:find("-->", 1, true) do i = i + 1 end
    if i <= #lines and not lines[1]:match("^NOTE") and not lines[1]:match("^STYLE") and not lines[1]:match("^REGION") then
      local a, b = lines[i]:match("([%d:%.,]+)%s*%-%->%s*([%d:%.,]+)")
      local s, e = a and clockToMs(a), b and clockToMs(b)
      local body = {}
      for k = i + 1, #lines do body[#body + 1] = lines[k] end
      local raw = table.concat(body, "\n")
      local txt = cleanText(raw)
      if s and e and #txt > 0 then
        -- Vertical position, to order rows: {\an7-9} = top in SRT; line: setting in WebVTT.
        local y = raw:match("{\\an[789]}") and 0 or 100
        local lv, pct = lines[i]:match("line:(%-?[%d%.]+)(%%?)")
        if lv then
          lv = tonumber(lv)
          if pct == "%" then y = lv elseif lv < 0 then y = 1000 + lv else y = lv * 5 end
        end
        cues[#cues + 1] = { start = s, ["end"] = math.max(e, s + 1), text = txt, y = y, idx = #cues + 1 }
      end
    end
  end
  table.sort(cues, function(x, y)
    if x.start ~= y.start then return x.start < y.start end
    if x["end"] ~= y["end"] then return x["end"] < y["end"] end
    return x.idx < y.idx
  end)
  return mergeSameTime(cues)
end

-------------------------------------------------------------------------------
-- The estimate
-------------------------------------------------------------------------------
local function round(x) return math.floor(x + 0.5) end

local function estimateWords(cue)
  local toks = tokenize(cue.text)
  if #toks == 0 then return {} end
  local w, p, sum = {}, {}, 0
  for i, t in ipairs(toks) do
    w[i] = t.inst and 0 or weightOf(t.text)
    p[i] = t.inst and 0 or pauseAfter(t.text, t.br)
    sum = sum + w[i] + ((i < #toks) and p[i] or 0)
  end
  local dur = cue["end"] - cue.start
  local unit = 0
  if sum > 0 then unit = math.min(dur * TUNING.fill / sum, TUNING.unitMaxMs) end
  local acc = 0
  for i, t in ipairs(toks) do
    t.at = cue.start + round(acc * unit)
    acc = acc + w[i] + p[i]
  end
  return placeInstant(toks, cue.start)
end

local function spokenIndexes(ws)
  local list = {}
  for i, w in ipairs(ws) do if not w.inst then list[#list + 1] = i end end
  return list
end
-- Words revealed together: 1 (word mode) or chunkSize, more on a line too long to reveal word by word (a broken file).
local function groupSize(n, mode)
  return math.max(mode == "chunk" and TUNING.chunkSize or 1, math.ceil(n / TUNING.maxSteps))
end
local function chunkEndPos(k, n, size)
  return math.min(n, math.floor((k - 1) / size) * size + size)
end

-- Nothing may land after the line's end: a word timed past it shows when the line ends.
local function wordAt(cue, w) return math.min(w.at, cue["end"]) end
-- When a line leaves the screen: its end, or later so the last word stays up for holdMs.
local function showEnd(cue, mode)
  if mode == "off" then return cue["end"] end
  local last = cue.start
  for _, w in ipairs(cue.words) do if not w.inst then last = math.max(last, wordAt(cue, w)) end end
  return math.max(cue["end"], last + TUNING.holdMs)
end

local function revealSteps(cue, mode)
  local ws, steps = cue.words, {}
  if mode == "off" then return { cue.start } end
  local spoken = spokenIndexes(ws)
  local size = groupSize(#spoken, mode)
  for k = 1, #spoken do
    local at = wordAt(cue, ws[spoken[chunkEndPos(k, #spoken, size)]])
    if #steps == 0 or steps[#steps] ~= at then steps[#steps + 1] = at end
  end
  if #steps == 0 or steps[1] > cue.start then table.insert(steps, 1, cue.start) end
  return steps
end

local function revealCue(cue, tp, mode)
  local ws = cue.words
  local n, vis, lastPos = #ws, {}, 0
  local spoken = spokenIndexes(ws)
  local size = groupSize(#spoken, mode)
  for k = 1, #spoken do
    local on
    if mode == "off" then on = true
    else on = tp >= wordAt(cue, ws[spoken[chunkEndPos(k, #spoken, size)]]) end
    vis[spoken[k]] = on
    if on then lastPos = k end
  end
  local prevSpoken = 0
  for j = 1, n do
    if not ws[j].inst then prevSpoken = j
    elseif prevSpoken == 0 then vis[j] = (mode == "off") or tp >= cue.start
    else vis[j] = vis[prevSpoken] end
  end
  local fresh = {}
  if mode ~= "off" and lastPos > 0 then
    local from = math.floor((lastPos - 1) / size) * size + 1
    for q = from, lastPos do fresh[spoken[q]] = true end
  end
  local out = {}
  for i = 1, n do
    out[i] = { text = ws[i].text, br = ws[i].br, visible = vis[i] and true or false, fresh = fresh[i] or false }
  end
  return out
end

-------------------------------------------------------------------------------
-- ASS writer (same output as Spoilaint.toASS in the JS engine)
-------------------------------------------------------------------------------
local function assTime(ms)
  ms = math.max(0, round(ms))
  local cs = math.floor(ms / 10)
  local h, m, s, c = math.floor(cs / 360000), math.floor(cs / 6000) % 60, math.floor(cs / 100) % 60, cs % 100
  return string.format("%d:%02d:%02d.%02d", h, m, s, c)
end
local function assEscape(s) return (s:gsub("\\", "\226\167\181"):gsub("{", "("):gsub("}", ")")) end
local function hexToAssColour(hex)
  local h = hex:gsub("#", "")
  return "&H" .. (h:sub(5, 6) .. h:sub(3, 4) .. h:sub(1, 2)):upper() .. "&"
end

-- Lines we only estimated get this much extra delay; lines matched to real speech need none.
local ESTIMATE_MARGIN_MS = 300

local function toASS(cues, opts)
  local mode, lag = opts.mode or "word", opts.lag or 0
  local accent = hexToAssColour(opts.accent or "#FFB23F")
  local highlight = opts.highlight ~= false
  local box = opts.box and true or false
  local lines = {
    "[Script Info]",
    "; Made by Spoilaint: words appear as they are spoken",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default," .. (opts.font or "Segoe UI") .. "," .. (opts.size or 64) .. ",&H00FFFFFF,&H00FFFFFF," ..
      (box and "&H40000000" or "&H00000000") .. ",&H80000000,-1,0,0,0,100,100,0,0," ..
      (box and "3,8,0" or "1,3,1.5") .. ",2,120,120,70,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  }
  local baseLag = lag
  for _, cue in ipairs(cues) do
    lag = baseLag + ((cue.synced or mode == "off") and 0 or ESTIMATE_MARGIN_MS)
    local steps = revealSteps(cue, mode)
    for si, from in ipairs(steps) do
      local to = steps[si + 1] or showEnd(cue, mode)
      if to > from then
        local words = revealCue(cue, from, mode)
        local parts = {}
        for wi, w in ipairs(words) do
          local t = assEscape(w.text)
          if not w.visible then t = "{\\alpha&HFF&}" .. t .. "{\\alpha&H00&}"
          elseif highlight and w.fresh then t = "{\\c" .. accent .. "}" .. t .. "{\\c&HFFFFFF&}" end
          if w.br then t = t .. "\\N" elseif wi < #words then t = t .. " " end
          parts[#parts + 1] = t
        end
        lines[#lines + 1] = "Dialogue: 0," .. assTime(from + lag) .. "," .. assTime(to + lag) .. ",Default,,0,0,0,," .. table.concat(parts)
      end
    end
  end
  return table.concat(lines, "\r\n") .. "\r\n"
end

-------------------------------------------------------------------------------
-- Speech detection: move each word to when it is really spoken
--
-- ffmpeg turns the movie's dialogue (the centre channel of 5.1 audio, or the middle of stereo)
-- into a loudness track, one value every 20 ms, filtered to the speech band. For every subtitle
-- line we then find:
--   * the stretches where someone is talking (loud enough above the quiet around them), and
--   * the syllables inside them (small peaks of loudness).
-- Each word is moved onto its syllables: a 3-syllable word takes 3 peaks. If the syllable count
-- doesn't fit what we heard, words are spread over the talking time only (silence is skipped).
-- Lines where no clear speech is found keep the estimate.
-------------------------------------------------------------------------------
local FRAME_MS = 20
local SPEECH = {
  contextMs = 4000,     -- how far around a line we look to learn the quiet level
  minRangeDb = 6,       -- a line needs this much contrast between talking and quiet
  thresholdFrac = 0.6,  -- loud enough = quiet level + this share of the range ...
  minThresholdDb = 5,   -- ... and at least this many dB above quiet
  modulation = 0.5,     -- wobble threshold between typical (0) and strongest (1) wobble; 0 turns the check off
  looseFrac = 0.3,      -- with enough wobble, quieter frames count as talking too
  modulationStrict = 0, -- 1 = wobble is required even for loud frames
  closeGapFrames = 3,   -- gaps up to 60 ms inside speech are filled
  minRunFrames = 3,     -- talking shorter than 60 ms is ignored (clicks)
  peakDb = 2.5,         -- a syllable peak must rise this much above the dip before it
  peakGapFrames = 4,    -- syllables are at least 80 ms apart
  durationWeight = 0.5, -- how much a word's length in time counts when matching words to syllables
}
-- Tuned on bench/ (3 synthetic films with known word times, music and effects; stereo and 5.1):
-- words more than 0.1 s early fell from ~60% (estimate) to ~4% (stereo) and ~2% (5.1).

local function parseEnvelope(text)
  local E, t0 = {}, nil
  for pts, val in text:gmatch("pts_time:([%-%d%.]+)%s+lavfi%.astats%.Overall%.RMS_level=([^\r\n]+)") do
    if not t0 then t0 = tonumber(pts) * 1000 end
    local v = tonumber(val)
    if not v or v ~= v or v < -120 then v = -120 end
    E[#E + 1] = v
  end
  return E, t0 or 0
end

local function percentile(list, p)
  if #list == 0 then return -120 end
  local c = {}
  for i = 1, #list do c[i] = list[i] end
  table.sort(c)
  return c[math.max(1, math.min(#c, math.floor(p * #c + 0.5)))]
end

-- Moves the words of one cue onto detected speech. Returns true if it did.
local function alignCue(cue, E, t0)
  local nE = #E
  local function frameAt(ms) return math.floor((ms - t0) / FRAME_MS) + 1 end
  local function msAt(f) return t0 + (f - 1) * FRAME_MS end
  local a = math.max(1, frameAt(cue.start - 300))
  local b = math.min(nE, frameAt(cue["end"] + 200))
  if b - a < 5 then return false end
  local ctx = {}
  for f = math.max(1, frameAt(cue.start - SPEECH.contextMs)), math.min(nE, frameAt(cue["end"] + SPEECH.contextMs)) do
    ctx[#ctx + 1] = E[f]
  end
  local inWin = {}
  for f = a, b do inWin[#inWin + 1] = E[f] end
  local quiet, loud = percentile(ctx, 0.15), percentile(inWin, 0.95)
  if loud - quiet < SPEECH.minRangeDb then return false end
  local thr = quiet + math.max(SPEECH.minThresholdDb, SPEECH.thresholdFrac * (loud - quiet))

  -- Talking stretches. Speech makes loudness wobble several times a second (syllables); music and
  -- steady noise don't. So a frame counts as talking when it is loud enough AND wobbling.
  local voiced = {}
  if SPEECH.modulation > 0 then
    local M, ctxM, winM = {}, {}, {}
    local half = 5
    local function wobble(f)
      local lo, hi = math.max(1, f - half), math.min(nE, f + half - 1)
      local sum, sq, cnt = 0, 0, 0
      for g = lo, hi do local v = E[g]; sum = sum + v; sq = sq + v * v; cnt = cnt + 1 end
      local mean = sum / cnt
      return math.sqrt(math.max(0, sq / cnt - mean * mean))
    end
    local c1, c2 = math.max(1, frameAt(cue.start - SPEECH.contextMs)), math.min(nE, frameAt(cue["end"] + SPEECH.contextMs))
    for g = c1, c2, 2 do ctxM[#ctxM + 1] = wobble(g) end
    for g = a, b do M[g] = wobble(g); winM[#winM + 1] = M[g] end
    local mq, ml = percentile(ctxM, 0.2), percentile(winM, 0.9)
    local thrM = mq + SPEECH.modulation * (ml - mq)
    local thrLoose = quiet + math.max(3, SPEECH.looseFrac * (loud - quiet))
    for g = a, b do voiced[g] = (E[g] > thr) or (E[g] > thrLoose and M[g] > thrM) end
    if SPEECH.modulationStrict > 0 then
      for g = a, b do voiced[g] = E[g] > thrLoose and M[g] > thrM end
    end
  else
    for g = a, b do voiced[g] = E[g] > thr end
  end
  local gap = 0
  for f = a, b do
    if voiced[f] then
      if gap > 0 and gap <= SPEECH.closeGapFrames and f - gap > a then
        for g = f - gap, f - 1 do voiced[g] = true end
      end
      gap = 0
    else gap = gap + 1 end
  end
  local segs, f = {}, a
  while f <= b do
    if voiced[f] then
      local s = f
      while f <= b and voiced[f] do f = f + 1 end
      if f - s >= SPEECH.minRunFrames then segs[#segs + 1] = { s = s, e = f - 1 } end
    else f = f + 1 end
  end
  -- Drop talking that started before the window and ends right after the line appears:
  -- that is the previous line's speaker finishing.
  local startF = frameAt(cue.start)
  while #segs > 0 and segs[1].s <= a and segs[1].e < startF + 8 do table.remove(segs, 1) end
  if #segs == 0 then return false end
  local voicedFrames = 0
  for _, s in ipairs(segs) do voicedFrames = voicedFrames + (s.e - s.s + 1) end
  if voicedFrames * FRAME_MS < 250 then return false end

  -- Syllables: loudness peaks inside talking stretches. Each syllable starts at the dip before it.
  local Es = {}
  for g = a, b do
    local p, q = E[math.max(1, g - 1)], E[math.min(nE, g + 1)]
    Es[g] = (p + E[g] + q) / 3
  end
  local syl = {}
  for _, s in ipairs(segs) do
    local lastPeak, dipVal, dipF, found = nil, math.huge, s.s, false
    for g = s.s, s.e do
      local v = Es[g]
      if v < dipVal then dipVal, dipF = v, g end
      if g > s.s and g < s.e and v >= Es[g - 1] and v > Es[g + 1] and v - dipVal >= SPEECH.peakDb
        and (not lastPeak or g - lastPeak >= SPEECH.peakGapFrames) then
        syl[#syl + 1] = { onset = found and dipF or s.s }
        found, lastPeak, dipVal, dipF = true, g, v, g
      end
    end
    if not found then syl[#syl + 1] = { onset = s.s } end
  end

  -- Only spoken words are matched to speech; helper text follows them afterwards.
  local allWords = cue.words
  local ws = {}
  for _, wd in ipairs(allWords) do if not wd.inst then ws[#ws + 1] = wd end end
  local n = #ws
  if n == 0 then return false end
  local w, total = {}, 0
  for i = 1, n do w[i] = weightOf(ws[i].text); total = total + w[i] end
  if total <= 0 then return false end
  local P = #syl
  -- Silence before each syllable (0 if it isn't the first of a talking stretch).
  local gapMs, segOf = {}, {}
  do
    local k, prevEnd = 0, nil
    for si, s in ipairs(segs) do
      local first = true
      for _, sy in ipairs(syl) do
        if sy.onset >= s.s and sy.onset <= s.e and not sy.seen then
          sy.seen = true
          k = k + 1
          segOf[k] = si
          gapMs[k] = first and (prevEnd and (s.s - prevEnd) * FRAME_MS or 1000) or 0
          first = false
        end
      end
      prevEnd = s.e
    end
  end

  local times = {}
  if P >= n and P <= 5 * total + 4 then
    -- Best fit of words onto syllables (dynamic programming).
    -- start[i] = index of the syllable where word i starts.
    local r = P / total                       -- detected syllables per expected syllable
    local strongPause = {}
    for i = 2, n do strongPause[i] = pauseAfter(ws[i - 1].text, ws[i - 1].br) >= TUNING.pauseComma end
    local function boundaryCost(i, k)         -- word i starting at syllable k
      local g = gapMs[k] or 0
      if i == 1 then return 0 end
      if strongPause[i] then return g >= 150 and 0 or 1.5 end
      if g >= 300 then return 0.8 end         -- an unexpected pause mid-phrase is allowed, but costs
      return 0
    end
    -- Talking time per expected syllable in this line, for the duration check.
    local lastEnd = segs[#segs].e
    local perSyl = math.max(60, (lastEnd - syl[1].onset + 1) * FRAME_MS / total)
    local function spanCost(i, k, kNext)      -- word i covers syllables k .. kNext-1
      local c, e = kNext - k, r * w[i]
      local cost = (c - e) * (c - e) / math.max(1, e)
      local t1 = syl[k].onset
      local t2 = kNext <= P and syl[kNext].onset or lastEnd
      local dur, expDur = (t2 - t1) * FRAME_MS, w[i] * perSyl
      local dd = (dur - expDur) / expDur
      cost = cost + SPEECH.durationWeight * dd * dd
      for q = k + 1, kNext - 1 do             -- long silences rarely fall inside a word
        if (gapMs[q] or 0) >= 300 then cost = cost + 1.0 end
      end
      return cost
    end
    local INF = math.huge
    local D, from = {}, {}
    for i = 1, n do D[i], from[i] = {}, {} end
    D[1][1] = 0
    for i = 1, n - 1 do
      for k = i, P - (n - i) do
        local base = D[i][k]
        if base and base < INF then
          local maxNext = math.min(P - (n - i - 1), k + math.ceil(3 * r * w[i]) + 3)
          for k2 = k + 1, maxNext do
            local c = base + spanCost(i, k, k2) + boundaryCost(i + 1, k2)
            if not D[i + 1][k2] or c < D[i + 1][k2] then D[i + 1][k2], from[i + 1][k2] = c, k end
          end
        end
      end
    end
    local bestK, bestC = nil, INF
    for k = n, P do
      local base = D[n][k]
      if base then
        local c = base + spanCost(n, k, P + 1)
        if c < bestC then bestK, bestC = k, c end
      end
    end
    if bestK then
      local k = bestK
      for i = n, 1, -1 do
        times[i] = msAt(syl[k].onset)
        if i > 1 then k = from[i][k] end
      end
    end
  end
  if #times < n then
    -- Too few syllables found: spread words over talking time only.
    local before = 0
    for i = 1, n do
      local target, acc = before / total * voicedFrames, 0
      times[i] = msAt(segs[#segs].e)
      for _, s in ipairs(segs) do
        local len = s.e - s.s + 1
        if acc + len > target then times[i] = msAt(s.s + math.floor(target - acc)); break end
        acc = acc + len
      end
      before = before + w[i]
    end
  end
  -- Keep order, stay inside the line.
  for i = 1, n do
    local t = times[i]
    if i == 1 then t = math.max(cue.start, t) else t = math.max(t, times[i - 1] + 40) end
    times[i] = math.min(t, cue["end"] - 20)
  end
  for i = 1, n do ws[i].at = round(times[i]) end
  placeInstant(allWords, cue.start)
  cue.synced = true
  return true
end

local function alignCues(cues, E, t0)
  local done = 0
  for _, c in ipairs(cues) do
    if c.words and #c.words > 0 and alignCue(c, E, t0) then done = done + 1 end
  end
  return done
end

-- Subtitle text -> ASS text (nil if nothing usable)
-------------------------------------------------------------------------------
-- Forced alignment (0.6.0): the Spoilaint app runs a small speech model that finds where each
-- subtitle word is spoken (the text is known; only the timing is searched for). On real speech:
-- ~92% of words within 0.1 s, ~0.3% early, vs ~29% early for the loudness method above.
-- We send the words (<base>.words.txt) and read back one line per subtitle (<base>.align.txt).
-------------------------------------------------------------------------------
local function textHash(s)
  local h = 0
  for i = 1, #s do h = (h * 31 + s:byte(i)) % 4294967296 end
  return string.format("%08x", h)
end

-- One line per subtitle: start \t end \t flags (1 = helper text) \t words joined by \31
local function wordsFile(cues)
  local out = {}
  for _, c in ipairs(cues) do
    local flags, ws = {}, {}
    for i, w in ipairs(c.words) do
      flags[i] = w.inst and "1" or "0"
      ws[i] = (w.text:gsub("[\t\r\n\31]", " "))
    end
    out[#out + 1] = c.start .. "\t" .. c["end"] .. "\t" .. table.concat(flags) .. "\t" .. table.concat(ws, "\31")
  end
  local body = table.concat(out, "\r\n")
  local hash = textHash(body)
  return "hash=" .. hash .. "\r\n" .. body .. "\r\n", hash
end

-- Applies <base>.align.txt to the cues. Returns how many lines were matched, or nil if it's for other subtitles.
local function applyAlignment(cues, text, hash)
  local lines = {}
  for l in text:gmatch("[^\r\n]+") do lines[#lines + 1] = l end
  if lines[1] ~= "hash=" .. hash then return nil end
  -- The app may have found these subtitles shifted against the film: move every line (and its estimate) to fit.
  local first = 2
  local offset = tonumber((lines[2] or ""):match("^offset=(%-?%d+)$") or "")
  if offset then
    first = 3
    -- drifting subtitles (made for another frame rate) are stretched too: time x scale + offset
    local scale = tonumber((lines[3] or ""):match("^scale=([%d%.]+)$") or "")
    if scale then first = 4 else scale = 1 end
    if math.abs(offset) > 3600000 or scale < 0.8 or scale > 1.25 then return nil end  -- not something the app writes
    local function fit(t) return math.floor(t * scale + 0.5) + offset end
    for _, c in ipairs(cues) do
      c.start = fit(c.start); c["end"] = fit(c["end"])
      for _, w in ipairs(c.words) do w.at = fit(w.at) end
    end
    log(string.format("subtitles moved to fit the film (shift %+.1f s, stretch %.4f)", offset / 1000, scale))
  end
  local synced = 0
  for ci, c in ipairs(cues) do
    local l = lines[ci + first - 1]
    local ok, times
    if l then ok, times = l:match("^(%d)\t[^\t]*\t(.*)$") end
    if ok == "1" then
      local t, k = {}, 0
      for v in (times .. ","):gmatch("(%-?%d+),") do k = k + 1; t[k] = tonumber(v) end
      if k == #c.words then
        -- words the model couldn't place (no letters, e.g. "♪") sit between their neighbours
        local spoken = {}
        for i, w in ipairs(c.words) do if not w.inst then spoken[#spoken + 1] = i end end
        local last = c.start
        for si, i in ipairs(spoken) do
          local v = t[i]
          if v < 0 then
            local nextv
            for sj = si + 1, #spoken do if t[spoken[sj]] >= 0 then nextv = t[spoken[sj]]; break end end
            v = nextv and math.floor((last + nextv) / 2) or (last + 200)
          end
          v = math.max(v, last)
          if si > 1 then v = math.max(v, last + 40) end
          v = math.min(v, c["end"] - 20)
          c.words[i].at = v
          last = v
        end
        placeInstant(c.words, c.start)
        c.synced = true
        synced = synced + 1
      end
    end
  end
  return synced
end

-- sync (optional): {envelope = {E, t0}} from loudness, or {alignment = text} from the speech model.
-- Returns ass, cue count, synced count (nil count if the alignment is for other subtitles).
local function convert(text, opts, sync)
  local cues = parseSubs(toUTF8(text))
  if #cues == 0 then return nil end
  for _, c in ipairs(cues) do c.words = estimateWords(c) end
  local synced = 0
  if sync and sync.alignment then
    local _, hash = wordsFile(cues)
    synced = applyAlignment(cues, sync.alignment, hash)
    if not synced then return nil end
  elseif sync and sync.envelope then
    synced = alignCues(cues, sync.envelope.E, sync.envelope.t0)
  end
  return toASS(cues, opts), #cues, synced
end

-------------------------------------------------------------------------------
-- Files
-------------------------------------------------------------------------------
local function openFile(path, mode)
  if vlc and vlc.io and vlc.io.open then return vlc.io.open(path, mode) end
  return io.open(path, mode)
end
local function readFile(path)
  local f = openFile(path, "rb")
  if not f then return nil end
  local data = f:read("*a")
  f:close()
  return data
end
local function writeFile(path, data)
  local f = openFile(path, "wb")
  if not f then return false end
  f:write(data)
  f:close()
  return true
end
local function listDir(path)
  if vlc and vlc.io and vlc.io.readdir then
    local ok, list = pcall(vlc.io.readdir, path)
    if ok and list then return list end
    return {}
  end
  local list = {}
  local p = io.popen('ls -1 "' .. path .. '" 2>/dev/null')
  if p then for l in p:lines() do list[#list + 1] = l end p:close() end
  return list
end
-- Creates a folder and any missing parents.
local function mkdirs(path)
  if not (vlc and vlc.io and vlc.io.mkdir) then return end
  local norm = path:gsub("\\", "/")
  local prefix, rest = norm:match("^(%a:/)(.*)$")
  if not prefix then prefix, rest = norm:match("^(/)(.*)$") end
  if not prefix then prefix, rest = "", norm end
  local cur = prefix
  for part in rest:gmatch("[^/]+") do
    cur = (cur == "" or cur:sub(-1) == "/") and (cur .. part) or (cur .. "/" .. part)
    pcall(vlc.io.mkdir, cur, "0700")
  end
end

local function splitPath(path)
  local dir, file = path:match("^(.*)[/\\]([^/\\]+)$")
  if not dir then return ".", path end
  return dir, file
end

local function loadSettings()
  if not (vlc and vlc.config) then return end
  local text = readFile(vlc.config.userdatadir() .. "/spoilaint.ini")
  if not text then return end
  for line in text:gmatch("[^\r\n]+") do
    local k, v = line:match("^%s*([%w_]+)%s*=%s*(.-)%s*$")
    if k and SETTINGS[k] ~= nil then
      if type(SETTINGS[k]) == "number" then SETTINGS[k] = tonumber(v) or SETTINGS[k]
      elseif type(SETTINGS[k]) == "boolean" then SETTINGS[k] = (v == "1" or v == "true" or v == "yes")
      else SETTINGS[k] = v end
    end
  end
end

-------------------------------------------------------------------------------
-- Finding subtitles for a movie
-------------------------------------------------------------------------------
local SUB_EXT = { srt = true, vtt = true }

local function extOf(name) return (name:match("%.([^%.]+)$") or ""):lower() end
local function baseOf(name) return name:match("^(.*)%.[^%.]+$") or name end

local function scoreSub(name, base)
  local lower, b = name:lower(), base:lower()
  local stem = baseOf(lower)
  if stem == b then return 100 end
  local score = 0
  if stem:sub(1, #b) == b then score = 50 end
  if stem:match("[%._%- ]en$") or stem:match("[%._%- ]eng$") or stem:match("english") then score = score + 20 end
  if stem:match("forced") then score = score - 30 end
  if stem:match("sdh") or stem:match("[%._%- ]hi$") then score = score + 5 end
  return score
end

local function findSidecar(videoPath)
  local dir, file = splitPath(videoPath)
  local base = baseOf(file)
  local best, bestScore = nil, 0
  for _, name in ipairs(listDir(dir)) do
    if SUB_EXT[extOf(name)] then
      local s = scoreSub(name, base)
      if s >= 50 and s > bestScore then best, bestScore = dir .. "/" .. name, s end
    end
  end
  if best then return best end
  -- Subs/ folder (common in movie downloads): Subs/*.srt or Subs/<Movie>/*.srt
  for _, sub in ipairs({ "Subs", "subs", "Subtitles", "subtitles", "Subs/" .. base }) do
    local sdir = dir .. "/" .. sub
    for _, name in ipairs(listDir(sdir)) do
      if SUB_EXT[extOf(name)] then
        local s = 10 + scoreSub(name, base)
        if s > bestScore then best, bestScore = sdir .. "/" .. name, s end
      end
    end
  end
  return best
end

local function shellQuote(s)
  if IS_WINDOWS then return '"' .. s:gsub('"', '') .. '"' end
  return "'" .. s:gsub("'", "'\\''") .. "'"
end
local function runCapture(cmd)
  -- cmd.exe drops the outer quotes of a command line that starts with a quote; wrap it once more.
  if IS_WINDOWS then cmd = '"' .. cmd .. '"' end
  local p = io.popen(cmd)
  if not p then return nil end
  local out = p:read("*a")
  p:close()
  return out
end

-------------------------------------------------------------------------------
-- The Spoilaint app (Windows tray app; on macOS the background helper) runs ffmpeg and the speech model for
-- us, so no console windows appear. We hand it a job file in its jobs folder (%LOCALAPPDATA%\Spoilaint\jobs,
-- ~/Library/Application Support/Spoilaint/jobs) and it writes the same outputs the old console script did.
-- It shows progress and keeps a list of synced films.
-------------------------------------------------------------------------------
-- %LOCALAPPDATA%\Spoilaint. Taken from VLC's own (UTF-8) folder when possible: os.getenv gives the ANSI form,
-- which doesn't open when the Windows user name has non-English letters.
local IS_MAC = not IS_WINDOWS and io.open("/System/Library/CoreServices/SystemVersion.plist", "rb") ~= nil
local function appDir()
  if not IS_WINDOWS then
    local home = os.getenv("HOME")
    if not home then return nil end
    return home .. (IS_MAC and "/Library/Application Support/Spoilaint" or "/.local/share/Spoilaint")
  end
  local ud = vlc and vlc.config and vlc.config.userdatadir and vlc.config.userdatadir()
  if ud then
    local base = ud:gsub("[/\\]+$", ""):match("^(.*)[/\\][Rr]oaming[/\\][Vv][Ll][Cc]$")
    if base then return base .. "\\Local\\Spoilaint" end
  end
  local la = os.getenv("LOCALAPPDATA")
  return la and (la .. "\\Spoilaint") or nil
end
local function appAlive()
  local d = appDir()
  if not d then return false end
  for _ = 1, 2 do
    local t = tonumber((readFile(d .. SEP .. "helper.alive") or ""):match("%d+") or "")
    if t then return math.abs(os.time() - t) <= 10 end
    pcall(vlc.misc.mwait, vlc.misc.mdate() + 100000) -- caught it mid-write: look again
  end
  return false
end
local appLaunched = false
-- True when the app is running (starting it if it's installed but closed).
local function ensureApp()
  if not vlc then return false end
  if appAlive() then return true end
  local d = appDir()
  local exe = d and (IS_WINDOWS and (d .. "\\Spoilaint.exe") or (d .. "/bin/spoilaint-helper"))
  local f = exe and openFile(exe, "rb")
  if not f then return false end
  f:close()
  if not appLaunched then
    appLaunched = true
    log("starting the Spoilaint app")
    if IS_WINDOWS then
      os.execute('start "" "' .. exe .. '" --background')
    elseif IS_MAC then
      -- normally running all the time (a launch agent); this restarts it if it was quit
      os.execute("launchctl kickstart gui/$(id -u)/app.spoilaint.helper >/dev/null 2>&1 || (" ..
        shellQuote(exe) .. " serve >/dev/null 2>&1 &)")
    else
      os.execute("(" .. shellQuote(exe) .. " serve >/dev/null 2>&1 &)")
    end
  end
  for _ = 1, 24 do
    if appAlive() then return true end
    if not pcall(vlc.misc.mwait, vlc.misc.mdate() + 250000) then return false end
  end
  log("the Spoilaint app didn't start")
  return false
end
local jobCounter = 0
local function submitJob(name, fields)
  local d = appDir() .. SEP .. "jobs"
  mkdirs(d)
  jobCounter = jobCounter + 1
  fields.id = tostring(os.time()) .. "-" .. jobCounter
  local lines = {}
  for _, k in ipairs({ "id", "task", "video", "dir", "base", "title", "out", "pos" }) do
    if fields[k] then lines[#lines + 1] = k .. "=" .. fields[k] end
  end
  lines[#lines + 1] = "end=1"
  if not writeFile(d .. SEP .. name .. ".job", table.concat(lines, "\r\n") .. "\r\n") then return nil end
  return fields.id
end
-- Tells the app how many lines matched speech, for its list of synced films.
local function reportResult(base, title, synced, count, cached)
  if not appAlive() then return end
  writeFile(appDir() .. SEP .. "jobs" .. SEP .. base .. ".result", table.concat({
    "base=" .. base, "title=" .. (title or base), "synced=" .. synced, "count=" .. count,
    "cached=" .. (cached and "1" or "0"), "end=1" }, "\r\n") .. "\r\n")
end

local function extractViaApp(videoPath, outPath)
  local _, file = splitPath(videoPath)
  local id = submitJob("extract-" .. tostring(os.time()), { task = "extract", video = videoPath, out = outPath, title = file })
  if not id then return nil end
  local marker = outPath .. ".done"
  local deadline = vlc.misc.mdate() + 90000000
  while vlc.misc.mdate() < deadline do
    local m = readFile(marker)
    if m and m:find("id=" .. id, 1, true) then
      if m:find("ok=1", 1, true) then return outPath end
      log("no text subtitle track inside this file")
      return nil
    end
    if not pcall(vlc.misc.mwait, vlc.misc.mdate() + 250000) then return nil end
  end
  log("reading the subtitles inside the file took too long")
  return nil
end

-- Pulls the best text subtitle track out of a video with ffmpeg. Returns the .srt path or nil.
local TEXT_CODECS = { subrip = true, srt = true, ass = true, ssa = true, mov_text = true, webvtt = true, text = true }
local function extractEmbedded(videoPath, outPath)
  if ensureApp() then return extractViaApp(videoPath, outPath) end
  local ffmpeg = (SETTINGS.ffmpeg ~= "" and SETTINGS.ffmpeg) or "ffmpeg"
  local probe = runCapture(shellQuote(ffmpeg) .. " -hide_banner -nostdin -i " .. shellQuote(videoPath) .. " 2>&1")
  if not probe or not probe:find("Stream", 1, true) then log("ffmpeg not found or no streams; skipping embedded subtitles"); return nil end
  local best, bestScore = nil, -1
  for line in probe:gmatch("[^\r\n]+") do
    local idx, lang, codec = line:match("Stream #0:(%d+)%(?(%a*)%)?[^:]*: Subtitle: ([%w_]+)")
    if idx and TEXT_CODECS[codec] then
      local s = 1
      if lang == "eng" or lang == "en" then s = s + 10 end
      if line:lower():find("forced", 1, true) then s = s - 5 end
      if s > bestScore then best, bestScore = idx, s end
    end
  end
  if not best then log("no text subtitle track inside this file"); return nil end
  runCapture(shellQuote(ffmpeg) .. " -hide_banner -nostdin -v error -y -i " .. shellQuote(videoPath) ..
    " -map 0:" .. best .. " -c:s srt " .. shellQuote(outPath) .. " 2>&1")
  local data = readFile(outPath)
  if data and #data > 0 then return outPath end
  return nil
end

-------------------------------------------------------------------------------
-- Main loop
-------------------------------------------------------------------------------
local function safeName(s)
  local h = 0
  for i = 1, #s do h = (h * 31 + s:byte(i)) % 4294967296 end
  local _, file = splitPath(s)
  local base = baseOf(file):gsub("[^%w%-_ ]", "_"):sub(1, 60)
  return base .. "-" .. string.format("%08x", h)
end

-- First writable folder of: VLC cache dir, VLC user data dir, TEMP.
local cachedFolder
local function cacheDir()
  if cachedFolder then return cachedFolder end
  local candidates = {}
  if vlc.config.cachedir then candidates[#candidates + 1] = vlc.config.cachedir() end
  candidates[#candidates + 1] = vlc.config.userdatadir()
  candidates[#candidates + 1] = os.getenv("TEMP") or os.getenv("TMPDIR") or "/tmp"
  for _, base in ipairs(candidates) do
    if base and base ~= "" then
      local d = base .. "/spoilaint"
      mkdirs(d)
      if writeFile(d .. "/.probe", "ok") then cachedFolder = d; return d end
    end
  end
  return nil
end

-- VLC also loads the movie's own subtitles, sometimes a moment after ours, and may pick them.
-- For the first few seconds keep switching to our track (its name contains "spoilaint", taken
-- from the file name). Once ours has stayed on for 4 seconds we stop, so if the viewer picks
-- another track later, we leave it alone.
local function selectOurTrack(uri, notice)
  local deadline = vlc.misc.mdate() + 20000000
  local steadySince, lastListed, announced = nil, "", false
  while vlc.misc.mdate() < deadline do
    local input = vlc.object.input()
    local item = input and vlc.input.item()
    if not item or item:uri() ~= uri then log("movie changed; stopped"); return end
    local ok, values, texts = pcall(vlc.var.get_list, input, "spu-es")
    if ok and values and texts then
      local listed = {}
      for i, text in ipairs(texts) do listed[#listed + 1] = tostring(values[i]) .. "=" .. tostring(text) end
      local cur = vlc.var.get(input, "spu-es")
      local summary = table.concat(listed, " | ") .. "  (showing " .. tostring(cur) .. ")"
      if summary ~= lastListed then log("subtitle tracks: " .. summary); lastListed = summary end
      local ours
      for i, text in ipairs(texts) do
        if tostring(text):lower():find("spoilaint", 1, true) then ours = values[i] end
      end
      if ours then
        if cur ~= ours then
          vlc.var.set(input, "spu-es", ours)
          steadySince = nil
          log("switched to the spoilaint track (" .. tostring(ours) .. ")")
        else
          if not announced then
            announced = true
            if vlc.osd and vlc.osd.message then
              pcall(vlc.osd.message, notice or "Spoilaint: word-by-word subtitles on", nil, "top-left", 4000000)
            end
          end
          steadySince = steadySince or vlc.misc.mdate()
          if vlc.misc.mdate() - steadySince > 4000000 then log("spoilaint track is showing"); return end
        end
      end
    end
    if not pcall(vlc.misc.mwait, vlc.misc.mdate() + 250000) then return end
  end
  log("gave up waiting for the spoilaint track")
end

-------------------------------------------------------------------------------
-- Speech detection in the background
-------------------------------------------------------------------------------
local function fileExists(p)
  local f = openFile(p, "rb")
  if f then f:close(); return true end
  return false
end

local function ffmpegPath()
  if SETTINGS.ffmpeg ~= "" then return SETTINGS.ffmpeg end
  if IS_WINDOWS then
    local la = os.getenv("LOCALAPPDATA")
    if la and fileExists(la .. "\\Spoilaint\\ffmpeg.exe") then return la .. "\\Spoilaint\\ffmpeg.exe" end
  else
    local d = appDir()
    if d and fileExists(d .. "/bin/ffmpeg") then return d .. "/bin/ffmpeg" end
  end
  return "ffmpeg"
end

-- The loudness of the dialogue, 50 values a second, in the speech band.
local FILTER_TAIL = "aresample=16000,highpass=f=250,lowpass=f=3500,asetnsamples=n=320:p=0," ..
  "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level," ..
  "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file="

-- Starts ffmpeg without waiting for it. When it finishes, <base>.speech.done appears.
local function startSpeechAnalysis(videoPath, dir, base)
  local ff = ffmpegPath()
  local tmp, final, done, err = base .. ".speech.tmp", base .. ".speech.txt", base .. ".speech.done", base .. ".speech.err"
  if ensureApp() then
    local _, file = splitPath(videoPath)
    return submitJob(base .. ".speech", { task = "speech", video = videoPath, dir = nativePath(dir), base = base, title = file }) ~= nil
  end
  if IS_WINDOWS then
    -- No Spoilaint app: fall back to a hidden console script (a window may flash briefly).
    -- % has a meaning in .cmd files; double it in paths.
    videoPath = videoPath:gsub("%%", "%%%%")
    ff = ff:gsub("%%", "%%%%")
    local d = dir:gsub("/", "\\")
    local cmdPath = d .. "\\" .. base .. ".speech.cmd"
    local script = table.concat({
      "@echo off",
      "chcp 65001 >nul",
      'cd /d "' .. d .. '"',
      -- Dialogue lives in the centre channel of 5.1/7.1; in stereo it sits in the middle.
      'set "PAN=pan=mono|c0=0.5*FL+0.5*FR"',
      '"' .. ff .. '" -hide_banner -nostdin -i "' .. videoPath .. '" 2>&1 | findstr /R /C:"Audio:.*[5-7]\\.1" >nul && set "PAN=pan=mono|c0=FC"',
      '"' .. ff .. '" -hide_banner -nostdin -i "' .. videoPath .. '" 2>&1 | findstr /R /C:"Audio:.*mono" >nul && set "PAN=anull"',
      '"' .. ff .. '" -nostdin -v error -y -i "' .. videoPath .. '" -map 0:a:0 -vn -sn -dn -af "%PAN%,' .. FILTER_TAIL .. tmp .. '" -f null - 2> "' .. err .. '"',
      'if exist "' .. tmp .. '" move /y "' .. tmp .. '" "' .. final .. '" >nul',
      'echo done> "' .. done .. '"',
      ""
    }, "\r\n")
    if not writeFile(cmdPath, script) then return false end
    -- Run it with no window. (wscript hides the console; the brief flash of os.execute is unavoidable.)
    local vbsPath = d .. "\\run-hidden.vbs"
    writeFile(vbsPath, 'CreateObject("WScript.Shell").Run """" & WScript.Arguments(0) & """", 0, False\r\n')
    os.execute('wscript.exe //B //Nologo "' .. vbsPath .. '" "' .. cmdPath .. '"')
  else
    local q = shellQuote
    local sh = "cd " .. q(dir) .. " && ( PAN='pan=mono|c0=0.5*FL+0.5*FR'; " ..
      q(ff) .. " -hide_banner -nostdin -i " .. q(videoPath) .. " 2>&1 | grep -Eq 'Audio:.*[5-7]\\.1' && PAN='pan=mono|c0=FC'; " ..
      q(ff) .. " -hide_banner -nostdin -i " .. q(videoPath) .. " 2>&1 | grep -Eq 'Audio:.*mono' && PAN='anull'; " ..
      q(ff) .. " -nostdin -v error -y -i " .. q(videoPath) .. " -map 0:a:0 -vn -sn -dn -af \"$PAN," .. FILTER_TAIL .. tmp ..
      "\" -f null - 2> " .. q(err) .. "; [ -f " .. q(tmp) .. " ] && mv -f " .. q(tmp) .. " " .. q(final) ..
      "; echo done > " .. q(done) .. " ) >/dev/null 2>&1 &"
    os.execute(sh)
  end
  return true
end

local function loadEnvelope(dir, base)
  local text = readFile(dir .. "/" .. base .. ".speech.txt")
  if not text or #text < 100 then return nil end
  local E, t0 = parseEnvelope(text)
  if #E < 50 then return nil end
  return { E = E, t0 = t0 }
end

-------------------------------------------------------------------------------
-- Main loop
-------------------------------------------------------------------------------
local titles = {}   -- base -> the movie's file name (for the app's list)
local NOTICE_CACHED = "Spoilaint: subtitles synced to speech"
local pending = nil -- a movie whose speech is being analysed: {uri, dir, base, subPath, data, started}

local function assOptions()
  return {
    mode = SETTINGS.mode, lag = SETTINGS.lag, font = SETTINGS.font, size = SETTINGS.size, box = SETTINGS.box,
    highlight = SETTINGS.highlight, accent = THEMES[SETTINGS.theme] or THEMES.amber
  }
end

-- Writes the word-by-word file, loads it in VLC and makes sure it is the one showing.
-- sync: nil (estimate), {alignment = text} (speech model) or {envelope = ...} (loudness, older method).
local function loadTrack(uri, dir, base, data, sync, notice)
  local ass, count, synced = convert(data, assOptions(), sync)
  if not ass then
    if sync and sync.alignment then log("the saved timing is for other subtitles"); return false end
    log("no usable lines in the subtitles"); return false
  end
  local outPath = dir .. "/" .. base .. (sync and ("-synced" .. (sync.suffix or "")) or "") .. ".spoilaint.ass"
  if not writeFile(outPath, "\239\187\191" .. ass) then log("couldn't write " .. outPath); return false end
  vlc.input.add_subtitle(outPath, true)
  if sync then
    log(string.format("matched %d of %d lines to speech (%s)", synced, count, sync.alignment and "speech model" or "loudness"))
    reportResult(base, titles[base], synced, count, notice == NOTICE_CACHED)
  else log(string.format("loaded %d lines (estimated timing)", count)) end
  selectOurTrack(uri, notice)
  return true
end

-- Can the Spoilaint app match words with its speech model? (it says so in helper.alive)
local function appCanAlign()
  if not ensureApp() then return false end
  return (readFile(appDir() .. SEP .. "helper.alive") or ""):find("align", 1, true) ~= nil
end

-- The words of these subtitles, as the app reads them; nil if there are none.
local function wordsFor(data)
  local cues = parseSubs(toUTF8(data))
  if #cues == 0 then return nil end
  for _, c in ipairs(cues) do c.words = estimateWords(c) end
  return wordsFile(cues)
end

local function handle(uri)
  if not uri:match("^file:") then return end
  local path = vlc.strings.make_path(uri)
  if not path then return end
  loadSettings() -- the Spoilaint app may have changed them since the last movie
  if SETTINGS.mode == "off" then return end
  local subPath = findSidecar(path)
  local cache = cacheDir()
  if not cache then log("no writable folder for the converted subtitles"); return end
  local key = safeName(path)
  local base = key:gsub("[^%w%-_]", "_")
  titles[base] = select(2, splitPath(path))
  if not subPath then
    local ext = extOf(path)
    if ext == "mkv" or ext == "mp4" or ext == "m4v" or ext == "mov" or ext == "webm" then
      local extracted = cache .. "/" .. key .. ".embedded.srt"
      local existing = readFile(extracted)
      if existing and #existing > 0 then subPath = extracted
      else subPath = extractEmbedded(path, extracted) end
    end
  end
  if not subPath then log("no subtitles found for " .. path); return end
  local data = readFile(subPath)
  if not data then log("couldn't read " .. subPath); return end
  log("subtitles: " .. subPath)

  -- 1. Words already matched to speech for these exact subtitles (opened before).
  local words, hash = wordsFor(data)
  local alignPath = cache .. "/" .. base .. ".align.txt"
  local saved = readFile(alignPath)
  if saved and hash and saved:match("^hash=(%x+)") == hash then
    if loadTrack(uri, cache, base, data, { alignment = saved }, NOTICE_CACHED) then return end
  end
  -- 2. Show the estimate now, then match words to speech in the background (Spoilaint app).
  if words and appCanAlign() then
    loadTrack(uri, cache, base, data, nil, "Spoilaint: word-by-word subtitles on (matching words to speech...)")
    local wordsPath = cache .. "/" .. base .. ".words.txt"
    if writeFile(wordsPath, words) then
      local _, file = splitPath(path)
      -- a done-marker from an earlier run (failed, or other subtitles) must not end this one
      if vlc.io and vlc.io.unlink then pcall(vlc.io.unlink, cache .. "/" .. base .. ".align.done") end
      -- where the viewer is (VLC may resume midway): the app matches that stretch first
      local posMs = 0
      local input = vlc.object.input()
      if input then
        local ok, t = pcall(vlc.var.get, input, "time")
        if ok and type(t) == "number" and t > 0 then posMs = math.floor(t / 1000) end
      end
      local id = submitJob(base .. ".align", { task = "align", video = path, dir = nativePath(cache), base = base, title = file,
          out = nativePath(wordsPath), pos = tostring(posMs) })
      if id then
        pending = { kind = "align", id = id, uri = uri, dir = cache, base = base, data = data, hash = hash, started = vlc.misc.mdate() }
        log("matching words to speech in the Spoilaint app...")
        return
      end
    end
  end
  -- 3. Older method (no app or no speech model): loudness.
  local env = loadEnvelope(cache, base)
  if env then
    loadTrack(uri, cache, base, data, { envelope = env }, NOTICE_CACHED)
    return
  end
  loadTrack(uri, cache, base, data, nil, "Spoilaint: word-by-word subtitles on (syncing to speech...)")
  if fileExists(cache .. "/" .. base .. ".speech.done") then
    log("speech detection ran before and found nothing usable; see " .. base .. ".speech.err")
    return
  end
  if startSpeechAnalysis(path, cache, base) then
    pending = { kind = "speech", uri = uri, dir = cache, base = base, data = data, started = vlc.misc.mdate() }
    log("listening to the dialogue in the background...")
  end
end

local function checkPending(currentUri)
  if not pending then return end
  local p = pending
  -- The app publishes the stretch being watched first: load it as soon as it's there.
  if p.kind == "align" and not p.partLoaded then
    local partDone = readFile(p.dir .. "/" .. p.base .. ".align.part.done")
    if partDone and partDone:find("id=" .. p.id, 1, true) then
      p.partLoaded = true
      local part = readFile(p.dir .. "/" .. p.base .. ".align.part.txt")
      if part and currentUri == p.uri and part:match("^hash=(%x+)") == p.hash then
        loadTrack(p.uri, p.dir, p.base, p.data, { alignment = part, suffix = "-part" }, "Spoilaint: words matched to speech here (the rest of the film follows)")
      end
    end
  end
  local doneFile = p.dir .. "/" .. p.base .. (p.kind == "align" and ".align.done" or ".speech.done")
  local doneText = readFile(doneFile)
  if not doneText or (p.kind == "align" and p.id and not doneText:find("id=" .. p.id, 1, true)) then
    if vlc.misc.mdate() - p.started > 30 * 60 * 1000000 then log("speech matching took too long; gave up"); pending = nil end
    return
  end
  pending = nil
  if p.kind == "align" then
    local text = readFile(p.dir .. "/" .. p.base .. ".align.txt")
    if not text or text:match("^hash=(%x+)") ~= p.hash then
      log("matching words to speech failed; keeping the estimate. " .. (readFile(p.dir .. "/" .. p.base .. ".align.err") or ""):sub(1, 300))
      return
    end
    if currentUri == p.uri then
      loadTrack(p.uri, p.dir, p.base, p.data, { alignment = text }, "Spoilaint: words matched to speech")
    end
    return
  end
  local env = loadEnvelope(p.dir, p.base)
  if not env then
    local err = readFile(p.dir .. "/" .. p.base .. ".speech.err") or ""
    log("speech detection failed; keeping the estimate. ffmpeg said: " .. err:sub(1, 300))
    return
  end
  log(string.format("speech detection finished (%d s of audio)", math.floor(#env.E * FRAME_MS / 1000)))
  if currentUri == p.uri then
    loadTrack(p.uri, p.dir, p.base, p.data, { envelope = env }, "Spoilaint: subtitles synced to speech")
  end
end

local function run()
  pcall(function() logFile = openFile(vlc.config.userdatadir() .. "/spoilaint.log", "wb") end)
  loadSettings()
  log("running (mode=" .. SETTINGS.mode .. ", lag=" .. SETTINGS.lag .. "ms, ffmpeg=" .. ffmpegPath() .. ")")
  local lastUri, pendingUri, seenAt = nil, nil, 0
  while true do
    local input = vlc.object.input()
    local item = input and vlc.input.item()
    local uri = item and item:uri()
    if uri and uri ~= lastUri then
      -- Give the input a moment to start before attaching a track.
      if pendingUri ~= uri then pendingUri, seenAt = uri, vlc.misc.mdate()
      elseif vlc.misc.mdate() - seenAt > 400000 then
        lastUri = uri
        local ok, err = pcall(handle, uri)
        if not ok then log("error: " .. tostring(err)) end
      end
    elseif not uri then
      lastUri, pendingUri = nil, nil
    end
    local ok, err = pcall(checkPending, uri)
    if not ok then log("error: " .. tostring(err)) end
    -- mwait raises "Interrupted." when VLC closes: that's our cue to stop.
    if not pcall(vlc.misc.mwait, vlc.misc.mdate() + 250000) then return end
  end
end

-- Running inside VLC: start the loop. Loaded by the test runner: expose the parts.
if vlc and vlc.misc and vlc.object then
  run()
else
  return {
    convert = convert, wordsFile = wordsFile, applyAlignment = applyAlignment, parseEnvelope = parseEnvelope, alignCues = alignCues, SPEECH = SPEECH, parseSubs = parseSubs, estimateWords = estimateWords, toASS = toASS,
    weightOf = weightOf, pauseAfter = pauseAfter, tokenize = tokenize, toUTF8 = toUTF8,
    findSidecar = findSidecar, scoreSub = scoreSub
  }
end
