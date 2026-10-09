-- lua5.1 dump.lua <spoilaint.lua> <subs.srt> <env.txt>  -> TSV: cue idx word estimate_ms synced_ms
local M = dofile(arg[1])
local function read(p) local f = assert(io.open(p, "rb")); local d = f:read("*a"); f:close(); return d end
local cuesA = M.parseSubs(M.toUTF8(read(arg[2])))
local cuesB = M.parseSubs(M.toUTF8(read(arg[2])))
for _, c in ipairs(cuesA) do c.words = M.estimateWords(c) end
for _, c in ipairs(cuesB) do c.words = M.estimateWords(c) end
for k, v in (os.getenv("SPOIL_PARAMS") or ""):gmatch("([%w_]+)=([%d%.%-]+)") do M.SPEECH[k] = tonumber(v) end
local E, t0 = M.parseEnvelope(read(arg[3]))
local n = M.alignCues(cuesB, E, t0)
io.stderr:write(("synced %d of %d lines\n"):format(n, #cuesB))
for ci, c in ipairs(cuesA) do
  for wi, w in ipairs(c.words) do
    print(table.concat({ ci - 1, wi - 1, w.text, w.at, cuesB[ci].words[wi].at }, "\t"))
  end
end
