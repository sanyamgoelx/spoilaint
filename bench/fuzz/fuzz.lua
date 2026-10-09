-- lua5.1 bench/fuzz/fuzz.lua CASEDIR LISTFILE  -> every case through the VLC script's parse/estimate/.ass/words-file/
-- apply-alignment code, the same checks as fuzz.js, plus garbage alignment files. Exits 1 on any problem.
package.path = "./?.lua;" .. package.path
local M = dofile("vlc/spoilaint.lua")
local dir, list = arg[1], arg[2]
local bad, total, parsed = {}, 0, 0
local function rd(p) local f = io.open(p, "rb"); local x = f:read("*a"); f:close(); return x end
local function fin(x) return type(x) == "number" and x == x and x ~= math.huge and x ~= -math.huge end
local junkAlign = {
  "", "hash=zz\n", "hash=%s\n0\t1\t2\n", "hash=%s\nx\ty\tz\n", "hash=%s\n0\t0\t-999999999\n", "hash=%s\n99999\t0\t1000\n",
  "hash=%s\noffset=abc\nscale=0\n0\t0\t1000\n", "hash=%s\noffset=-99999999\nscale=1e308\n0\t0\t1000\n", "hash=%s\n0\t0\t1e400\n0\t1\tnan\n",
}
for name in io.lines(list) do
  total = total + 1
  local t0 = os.clock()
  local ok, err = pcall(function()
    local text = rd(dir .. "/" .. name)
    local cues = M.parseSubs(M.toUTF8(text))
    if #cues == 0 then return end
    parsed = parsed + 1
    for _, c in ipairs(cues) do
      if not fin(c.start) or not fin(c["end"]) then error("non-numeric line time") end
      c.words = M.estimateWords(c)
      for _, w in ipairs(c.words) do
        if not fin(w.at) then error("word time " .. tostring(w.at)) end
        if w.at < c.start or (w.at > math.max(c["end"], c.start) and not w.inst) then error("word at " .. w.at .. " outside " .. c.start .. ".." .. c["end"]) end
      end
    end
    for _, mode in ipairs({ "word", "chunk", "off" }) do
      local ass = M.toASS(cues, { mode = mode, lag = 300 })
      for l in ass:gmatch("[^\r\n]+") do
        if l:find("nan") or l:find("inf") and l:find("^Dialogue") or (l:find("^Dialogue:") and not l:find("^Dialogue: 0,%d+:%d%d:%d%d%.%d%d,%d+:%d%d:%d%d%.%d%d,")) then
          error(mode .. " .ass line: " .. l:sub(1, 100))
        end
      end
    end
    local words, hash = M.wordsFile(cues)
    for l in words:gmatch("[^\n]+") do
      if not l:find("^hash=") and not l:find("^%-?%d+\t%-?%d+\t[01]*\t") then error("words file line: " .. l:sub(1, 80)) end
    end
    for _, j in ipairs(junkAlign) do
      local r = M.convert(text, { mode = "word", lag = 300 }, { alignment = j:format(hash) })
      if r then for l in r:gmatch("[^\r\n]+") do
        if l:find("^Dialogue:") and not l:find("^Dialogue: 0,%d+:%d%d:%d%d%.%d%d,%d+:%d%d:%d%d%.%d%d,") then error("aligned .ass line: " .. l:sub(1, 100)) end
      end end
    end
    local f = io.open(dir .. "/../words/" .. name .. ".words.txt", "wb"); if f then f:write(words); f:close() end
  end)
  if not ok then bad[#bad + 1] = name .. ": " .. tostring(err) end
  if os.clock() - t0 > 5 then bad[#bad + 1] = name .. string.format(": took %.1f s", os.clock() - t0) end
end
for _, b in ipairs(bad) do print("  " .. b) end
print(string.format("VLC script: %d cases, %d parsed into lines, %d problems", total, parsed, #bad))
os.exit(#bad > 0 and 1 or 0)
