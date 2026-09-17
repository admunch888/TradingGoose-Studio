// tls-proxy.js — zero-dep TLS reverse proxy for the Obsidian MCP server.
// Terminates TLS on 127.0.0.1:8443 and pipes to 127.0.0.1:8317.
// Usage: OBSIDIAN_TLS_CERT=<path> OBSIDIAN_TLS_KEY=<path> node tls-proxy.js
const fs = require('fs')
const tls = require('tls')
const net = require('net')

const HOST = process.env.OBSIDIAN_TLS_HOST || '100.64.0.8'
const PORT = Number(process.env.OBSIDIAN_TLS_PORT || 8443)
const BACKEND_HOST = process.env.OBSIDIAN_TLS_BACKEND_HOST || '127.0.0.1'
const BACKEND_PORT = Number(process.env.OBSIDIAN_TLS_BACKEND_PORT || 8317)
const CERT = process.env.OBSIDIAN_TLS_CERT
const KEY = process.env.OBSIDIAN_TLS_KEY

if (!CERT || !KEY || !fs.existsSync(CERT) || !fs.existsSync(KEY)) {
  console.error('Missing OBSIDIAN_TLS_CERT / OBSIDIAN_TLS_KEY or files not found')
  process.exit(1)
}

const server = tls.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, (socket) => {
  socket.setNoDelay(true)
  const backend = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    socket.pipe(backend)
    backend.pipe(socket)
  })
  backend.on('error', (err) => {
    console.error(`backend error: ${err.message}`)
    socket.destroy()
  })
  socket.on('error', (err) => {
    console.error(`socket error: ${err.message}`)
    backend.destroy()
  })
})

server.on('tlsclienterror', (err) => {
  console.error(`tls error: ${err.message}`)
})

server.listen(PORT, HOST, () => {
  console.log(`TLS proxy: https://${HOST}:${PORT} -> ${BACKEND_HOST}:${BACKEND_PORT}`)
})
