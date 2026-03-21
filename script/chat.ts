/**
 * Simple CLI chat over Hyperswarm.
 *
 * Usage:
 *   # 64-char hex topic (32 bytes)
 *   node ./chat.js <topic>
 *
 * Then type messages and press ENTER to send. Incoming messages are printed to stdout.
 */

import Hyperswarm from 'hyperswarm'
import readline from 'readline'

const topic = process.argv[2] ?? process.env.HYPERSWARM_TOPIC
if (!topic) {
  console.error('Usage: node chat.js <topic> (64-char hex)')
  process.exit(1)
}

if (topic.length !== 64 || !/^[0-9a-f]+$/i.test(topic)) {
  console.error('Topic must be a 64-character hex string')
  process.exit(1)
}

const swarm = new Hyperswarm()
const key = Buffer.from(topic, 'hex')

const connections = new Set<import('stream').Duplex>()
let rl: readline.Interface | null = null

swarm.on('connection', (conn, info) => {
  const peerId = info.publicKey.toString('hex')
  console.log(`> connected: ${peerId}`)

  connections.add(conn)
  conn.on('close', () => {
    connections.delete(conn)
    console.log(`> disconnected: ${peerId}`)
  })

  conn.on('data', (data) => {
    process.stdout.write(`\n< ${peerId}: ${data.toString()}\n`)
    rl?.prompt(true)
  })

  conn.on('error', () => {})
})

async function main() {
  swarm.join(key, { server: true, client: true })
  await swarm.flush()
  console.log('Joined swarm. Type a message and press ENTER.')

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  })

  rl.prompt()
  rl.on('line', (line) => {
    const msg = line.trim()
    if (!msg) {
      rl.prompt()
      return
    }

    for (const conn of connections) {
      try {
        conn.write(msg)
      } catch {
        // ignore
      }
    }

    rl.prompt()
  })

  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
    rl?.close()
    swarm.destroy()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
