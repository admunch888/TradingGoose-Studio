// Obsidian Trade Journal MCP server (Streamable HTTP, zero dependencies).
//
// Access modes (OBSIDIAN_MODE):
//   direct (default): read/write markdown files straight from the vault folder
//   rest:             call the Obsidian Local REST API plugin (default https://127.0.0.1:27124)
//
// Auth: Bearer token via OBSIDIAN_MCP_TOKEN (required when used with TradingGoose).

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')

// Load .env from the script directory (process env already set takes precedence).
const dotenv = {}
try {
  const envFile = path.join(__dirname, '.env')
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim()
      dotenv[key] = val
      if (!process.env[key]) process.env[key] = val
    }
  }
} catch (e) {
  console.warn('Could not load .env:', e.message)
}

const PORT = Number(process.env.OBSIDIAN_MCP_PORT || 8317)
const HOST = process.env.OBSIDIAN_MCP_HOST || '127.0.0.1'
const TOKEN = process.env.OBSIDIAN_MCP_TOKEN || ''
const MODE = process.env.OBSIDIAN_MODE || 'direct'
const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR || ''
const REST_URL = process.env.OBSIDIAN_REST_URL || 'https://127.0.0.1:27124'
const REST_KEY = process.env.OBSIDIAN_API_KEY || ''
const JOURNAL_FOLDER = process.env.OBSIDIAN_JOURNAL_FOLDER || 'Trade Journal'
const READ_ONLY = String(process.env.OBSIDIAN_READ_ONLY || '').toLowerCase() === 'true'

const useRest = MODE === 'rest'

// ------------------------------------------------------------------ REST mode

function restRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const url = new URL(REST_URL + path)
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(
      url,
      {
        method,
        rejectUnauthorized: false, // plugin uses a self-signed cert
        headers: {
          Authorization: 'Bearer ' + REST_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(text)) } catch { resolve(text) }
          } else {
            reject(new Error(`REST ${method} ${path} -> ${res.statusCode}: ${text.slice(0, 300)}`))
          }
        })
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const restPath = (p) => (p.startsWith('/') ? p : '/' + p)

const apiReadNote = (p) => restRequest('GET', '/vault/' + restPath(p))
const apiWriteNote = (p, content) => restRequest('PUT', '/vault/' + restPath(p), { content })
const apiAppendNote = (p, content) =>
  restRequest('POST', '/vault/' + restPath(p), { content, operation: 'append' })
const apiSearch = (q) => restRequest('POST', '/search/simple/', { query: q })

// ------------------------------------------------------------- direct mode

function requireVaultDir() {
  if (!useRest) {
    if (!VAULT_DIR) throw new Error('OBSIDIAN_VAULT_DIR is not set (or set OBSIDIAN_MODE=rest)')
    if (!fs.existsSync(path.join(VAULT_DIR, '.obsidian'))) {
      throw new Error(`${VAULT_DIR} does not look like an Obsidian vault (no .obsidian folder)`)
    }
  }
}

// Resolve a vault-relative path to an absolute path, refusing traversal outside the vault.
function vaultFile(vpath) {
  const clean = String(vpath || '').replace(/^\/+/, '').replace(/\\/g, '/')
  if (clean.includes('..')) throw new Error('Path must not contain ".."')
  const abs = path.resolve(VAULT_DIR, clean)
  const root = path.resolve(VAULT_DIR)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path escapes the vault')
  }
  return abs
}

function directReadNote(vpath) {
  const abs = vaultFile(vpath)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    const err = new Error(`File not found: ${vpath}`)
    err.status = 404
    throw err
  }
  return { content: fs.readFileSync(abs, 'utf8') }
}

function directWriteNote(vpath, content, { append = false } = {}) {
  const abs = vaultFile(vpath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  if (append && fs.existsSync(abs)) {
    fs.appendFileSync(abs, content)
  } else {
    fs.writeFileSync(abs, content, 'utf8')
  }
}

// Crude full-text search over markdown files (direct mode only).
function directSearch(query) {
  const q = String(query).toLowerCase()
  const hits = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md')) {
        try {
          const text = fs.readFileSync(full, 'utf8')
          if (text.toLowerCase().includes(q)) {
            hits.push({ path: path.relative(VAULT_DIR, full).replace(/\\/g, '/') })
          }
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(VAULT_DIR)
  return hits
}

// ------------------------------------------------------------------ access layer

async function readNote(vpath) {
  if (useRest) {
    const res = await apiReadNote(vpath)
    return res.file ? res.file.content : res.content ?? String(res)
  }
  return directReadNote(vpath).content
}

async function writeNote(vpath, content, { append = false } = {}) {
  if (READ_ONLY) throw new Error('Server is read-only (OBSIDIAN_READ_ONLY=true)')
  if (useRest) {
    if (append) {
      try {
        await apiAppendNote(vpath, content)
      } catch (err) {
        // 404 -> create with header
        if (!/404|not found|no file/i.test(String(err.message))) throw err
        const date = path.basename(vpath).replace(/\.md$/, '')
        await apiWriteNote(vpath, `# Trade Journal ${date}\n\n${content}`)
      }
    } else {
      await apiWriteNote(vpath, content)
    }
  } else {
    directWriteNote(vpath, content, { append })
  }
}

async function search(query) {
  if (useRest) {
    const res = await apiSearch(query)
    return res.files ? res.files.map((f) => f.path.replace(/^\//, '')) : []
  }
  return directSearch(query)
}

// ------------------------------------------------------------------ helpers

const todayLabel = () => new Date().toISOString().slice(0, 10)
const textResult = (text) => ({ content: [{ type: 'text', text }] })
const errorResult = (err) => ({
  isError: true,
  content: [{ type: 'text', text: 'Error: ' + (err && err.message ? err.message : String(err)) }],
})

function formatEntry({ entry, symbol, tags }) {
  const lines = []
  if (symbol) lines.push('## ' + symbol)
  lines.push(String(entry).trim())
  const allTags = ['trade-journal', ...(tags || [])]
  if (allTags.length) lines.push('', allTags.map((t) => '#' + t).join(' '))
  return lines.join('\n')
}

// ------------------------------------------------------------------ tools

const tools = [
  {
    name: 'journal_append',
    description:
      'Append a trade journal entry to the daily note in the Obsidian vault (' +
      JOURNAL_FOLDER + '/YYYY-MM-DD.md). Creates the note if it does not exist. ' +
      'Markdown allowed. Entry is tagged #trade-journal plus any extra tags.',
    inputSchema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'The journal entry text (markdown allowed).' },
        symbol: { type: 'string', description: 'Instrument symbol, e.g. MES=F.' },
        date: { type: 'string', description: 'Optional YYYY-MM-DD. Defaults to today.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional extra Obsidian tags without leading #, e.g. ["win","mes"].',
        },
      },
      required: ['entry'],
    },
  },
  {
    name: 'journal_read',
    description: 'Read the trade journal daily note for a given date (default today).',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Optional YYYY-MM-DD. Defaults to today.' },
      },
      required: [],
    },
  },
  {
    name: 'journal_search',
    description: 'Full-text search across the Obsidian vault.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query.' } },
      required: ['query'],
    },
  },
  {
    name: 'vault_read',
    description: 'Read any markdown note from the Obsidian vault by vault-relative path (read-only).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Vault-relative path, e.g. Trade Journal/2026-09-16.md' } },
      required: ['path'],
    },
  },
  {
    name: 'vault_write',
    description:
      'Create or overwrite a markdown note in the Obsidian vault. Path must be inside the journal folder (' +
      JOURNAL_FOLDER + ').',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path inside the journal folder.' },
        content: { type: 'string', description: 'Full markdown content to write.' },
      },
      required: ['path', 'content'],
    },
  },
]

const toolHandlers = {
  async journal_append(args) {
    requireVaultDir()
    const date = args.date || todayLabel()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD')
    const vpath = JOURNAL_FOLDER + '/' + date + '.md'
    const entry = formatEntry(args) + '\n\n'
    await writeNote(vpath, entry, { append: true })
    return textResult('Appended entry to ' + vpath)
  },

  async journal_read(args) {
    requireVaultDir()
    const date = args.date || todayLabel()
    const vpath = JOURNAL_FOLDER + '/' + date + '.md'
    let content
    try {
      content = await readNote(vpath)
    } catch (err) {
      if (err.status === 404 || /not found/i.test(err.message)) {
        return textResult('No journal entry for ' + date + ' yet.')
      }
      throw err
    }
    return textResult('# ' + vpath + '\n\n' + (content || '(empty)'))
  },

  async journal_search(args) {
    requireVaultDir()
    const hits = await search(args.query)
    if (!hits.length) return textResult('No results for: ' + args.query)
    return textResult('Results for "' + args.query + '":\n' + hits.map((h) => '- ' + h).join('\n'))
  },

  async vault_read(args) {
    requireVaultDir()
    const content = await readNote(args.path)
    return textResult('# ' + args.path + '\n\n' + content)
  },

  async vault_write(args) {
    requireVaultDir()
    const target = String(args.path || '').replace(/^\/+/, '').replace(/\\/g, '/')
    const base = JOURNAL_FOLDER + '/'
    if (!target.startsWith(base)) {
      throw new Error('vault_write is restricted to the journal folder: ' + base)
    }
    await writeNote(target, String(args.content || ''))
    return textResult('Wrote ' + target)
  },
}

// ------------------------------------------------- MCP protocol (Streamable HTTP)

const PROTOCOL_VERSION = '2025-03-26'
const serverInfo = { name: 'obsidian-trade-journal', version: '1.0.0' }

const jsonrpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const jsonrpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

function handleRpc(msg) {
  const id = msg.id === undefined ? null : msg.id
  const respond = (result) => (id === null ? null : jsonrpcResult(id, result))
  const fail = (code, message) => (id === null ? null : jsonrpcError(id, code, message))

  switch (msg.method) {
    case 'initialize':
      return Promise.resolve(
        respond({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        })
      )
    case 'notifications/initialized':
      return Promise.resolve(null)
    case 'tools/list':
      return Promise.resolve(respond({ tools }))
    case 'tools/call': {
      const { name, arguments: args } = msg.params || {}
      const handler = toolHandlers[name]
      if (!handler) return Promise.resolve(fail(-32601, 'Unknown tool: ' + name))
      return Promise.resolve(handler(args || {}))
        .then((result) => jsonrpcResult(id, result))
        .catch((err) => jsonrpcResult(id, errorResult(err)))
    }
    case 'ping':
      return Promise.resolve(respond({}))
    default:
      return Promise.resolve(fail(-32601, 'Method not found: ' + msg.method))
  }
}

const server = http.createServer((req, res) => {
  const send = (status, body, headers = {}) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers })
    res.end(payload)
  }

  if (TOKEN) {
    const auth = req.headers['authorization'] || ''
    if (auth !== 'Bearer ' + TOKEN) {
      send(401, jsonrpcError(null, -32001, 'Unauthorized'))
      return
    }
  }

  if (req.method !== 'POST') {
    send(405, jsonrpcError(null, -32001, 'Only POST is supported (Streamable HTTP)'))
    return
  }

  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (!raw) {
      send(400, jsonrpcError(null, -32700, 'Empty body'))
      return
    }
    let messages
    try {
      // Accept a single JSON-RPC message, an array, or newline-delimited messages.
      messages = raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').map((l) => JSON.parse(l))
    } catch (err) {
      send(400, jsonrpcError(null, -32700, 'Invalid JSON: ' + err.message))
      return
    }
    if (!Array.isArray(messages)) messages = [messages]
    try {
      const responses = (await Promise.all(messages.map(handleRpc))).filter(Boolean)
      if (!responses.length) {
        res.writeHead(202)
        res.end()
        return
      }
      send(200, responses.length === 1 ? responses[0] : responses)
    } catch (err) {
      send(500, jsonrpcError(null, -32603, err.message))
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(
    `Obsidian trade journal MCP server: http://${HOST}:${PORT} | mode=${useRest ? 'rest' : 'direct'} | ` +
      (useRest ? `rest=${REST_URL}` : `vault=${VAULT_DIR}`) +
      ` | journal="${JOURNAL_FOLDER}" | auth=${TOKEN ? 'on' : 'off'}`
  )
})
