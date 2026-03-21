console.log('JS: >>> SCRIPT STARTING V17 <<<')

import { getIPC } from './lib/get-ipc'
import Buffer from 'bare-buffer'
import Hyperswarm from 'hyperswarm'

const IPC = getIPC()

let swarm: any = null
const connections = new Set<any>()

IPC.on('data', (chunk: Buffer) => {
  const str = chunk.toString()
  console.log('JS: [IPC DATA RECEIVED]:', str)
  try {
    const msg = JSON.parse(str)
    console.log('JS: [IPC PARSED MSG]:', typeof msg, msg)

    if (msg.cmd === 'swarm:join') {
        console.log('JS: -> calling joinSwarm with', msg.data.topic)
        joinSwarm(msg.data.topic)
    } else if (msg.cmd === 'swarm:send') {
        console.log('JS: -> calling sendMessage with', msg.data.message)
        sendMessage(msg.data.message)
    } else {
        console.log('JS: [IPC UNKNOWN CMD]:', msg.cmd)
    }
  } catch (e: any) {
    console.log('JS: [IPC JSON ERROR]:', e.message)
  }
})

function emit(type: string, data: any) {
  console.log('JS: [EMIT]:', type, data)
  const msg = JSON.stringify({ type, data })
  IPC.write(Buffer.from(msg))
}

async function joinSwarm(topic: string) {
  console.log('JS: joinSwarm starting...')
  if (swarm) {
    console.log('JS: destroying existing swarm')
    await swarm.destroy()
    connections.clear()
  }

  emit('swarm:status', { status: 'joining' })

  try {
    console.log('JS: creating new Hyperswarm')
    swarm = new Hyperswarm()
    swarm.on('connection', (conn: any, info: any) => {
      const peer = info.publicKey.toString('hex')
      console.log('JS: new connection from', peer)
      connections.add(conn)
      emit('swarm:peer', { peer })

      conn.on('data', (data: Buffer) => {
        emit('swarm:data', { peer, data: data.toString() })
      })
      conn.on('close', () => {
          console.log('JS: connection closed for', peer)
          connections.delete(conn)
      })
    })

    const topicBuffer = Buffer.from(topic, 'hex')
    console.log('JS: joining topic', topic)
    swarm.join(topicBuffer)

    console.log('JS: flushing swarm...')
    await swarm.flush()
    console.log('JS: swarm flushed')
    emit('swarm:status', { status: 'ready' })
  } catch (err: any) {
    console.error('JS: [SWARM ERROR]:', err)
    emit('error', { message: 'Failed to join swarm: ' + err.message })
  }
}

function sendMessage(message: string) {
  if (!swarm || connections.size === 0) {
    console.log('JS: cannot send, no peers connected')
    emit('error', { message: 'No peers connected' })
    return
  }
  console.log('JS: sending message to', connections.size, 'peers')
  for (const conn of connections) {
    conn.write(message)
  }
}

// Keep the process alive
setInterval(() => {}, 1000 * 60 * 60)

emit('ready', { version: 17 })
