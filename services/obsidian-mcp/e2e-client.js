// E2E test via Node fetch. Server must be running on 127.0.0.1:8319.
const BASE = 'http://127.0.0.1:8319/mcp'
const TOKEN = 'realtoken'

async function rpc(id, method, params) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const text = await res.text()
  return { status: res.status, body: text.slice(0, 1500) }
}

;(async () => {
  const auth = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  console.log('AUTH (expect 401):', auth.status)

  const init = await rpc(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1.0' },
  })
  console.log('INITIALIZE:', init.status, init.body.slice(0, 300))

  const list = await rpc(10, 'tools/list', {})
  console.log('TOOLS/LIST:', list.status, list.body.slice(0, 300))

  const append = await rpc(2, 'tools/call', {
    name: 'journal_append',
    arguments: { date: '2026-09-16', entry: 'E2E write test from Windows-context launch', symbol: 'TEST', tags: ['smoke-test'] },
  })
  console.log('APPEND:', append.status, append.body)

  const read = await rpc(3, 'tools/call', { name: 'journal_read', arguments: { date: '2026-09-16' } })
  console.log('READ:', read.status, read.body.slice(0, 800))
})().catch((e) => {
  console.error('E2E failed:', e.message)
  process.exit(1)
})
