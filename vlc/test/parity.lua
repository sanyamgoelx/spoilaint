-- usage: lua5.1 parity.lua <in.srt> <out.ass> <mode> <lag>
local M = dofile(arg[0]:gsub("parity.lua$", "") .. "../spoilaint.lua")
local f = assert(io.open(arg[1], "rb")); local data = f:read("*a"); f:close()
local ass = M.convert(data, { mode = arg[3], lag = tonumber(arg[4]), font = "Segoe UI", size = 64, box = false, highlight = true, accent = "#FFB23F" })
local o = assert(io.open(arg[2], "wb")); o:write(ass); o:close()
