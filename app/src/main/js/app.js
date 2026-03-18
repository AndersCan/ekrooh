console.log('JS: >>> SCRIPT STARTING V13 <<<')

const { IPC } = BareKit
const Buffer = require('bare-buffer')
const Hyperswarm = require('hyperswarm')

// Explicitly resume the IPC stream
if (IPC.resume) {
  console.log('JS: Resuming IPC stream...')
  IPC.resume()
}

let swarm = null
const connections = new Set()

IPC.on('data', (chunk) => {
  const str = chunk.toString()
  console.log('JS: [IPC DATA RECEIVED]:', str)
  try {
    const msg = JSON.parse(str)
    if (msg.cmd === 'swarm:join') {
        console.log('JS: [CMD] joinSwarm:', msg.data.topic)
        joinSwarm(msg.data.topic)
    } else if (msg.cmd === 'swarm:send') {
        console.log('JS: [CMD] sendMessage:', msg.data.message)
        sendMessage(msg.data.message)
    }
  } catch (e) {
    console.log('JS: [IPC JSON ERROR]:', e.message)
  }
})

function emit(type, data) {
  const msg = JSON.stringify({ type, data })
  console.log('JS: [IPC SENDING]:', msg)
  IPC.write(Buffer.from(msg))
}

async function joinSwarm(topic) {
  console.log('JS: [SWARM] Joining topic:', topic)

  if (swarm) {
    console.log('JS: [SWARM] Destroying old swarm')
    await swarm.destroy()
    connections.clear()
  }

  emit('swarm:status', { status: 'joining' })

  try {
    swarm = new Hyperswarm()

    swarm.on('connection', (conn, info) => {
      const peer = info.publicKey.toString('hex')
      console.log('JS: [SWARM] New peer connected:', peer)

      connections.add(conn)
      emit('swarm:peer', { peer })

      conn.on('data', (data) => {
        const message = data.toString()
        console.log('JS: [SWARM] Data from peer:', message)
        emit('swarm:data', { peer, data: message })
      })

      conn.on('close', () => {
        console.log('JS: [SWARM] Peer disconnected:', peer)
        connections.delete(conn)
      })

      conn.on('error', (err) => {
        console.error('JS: [SWARM] Peer error:', err.message)
      })
    })

    const topicBuffer = Buffer.from(topic, 'hex')
    swarm.join(topicBuffer)

    console.log('JS: [SWARM] Flushing...')
    await swarm.flush()
    console.log('JS: [SWARM] Joined and flushed successfully')
    emit('swarm:status', { status: 'ready' })

  } catch (err) {
    console.error('JS: [SWARM] Join error:', err.message)
    emit('error', { message: 'Failed to join swarm: ' + err.message })
  }
}

function sendMessage(message) {
  if (!swarm || connections.size === 0) {
    console.log('JS: [SWARM] No peers to send to')
    emit('error', { message: 'No peers connected' })
    return
  }

  console.log('JS: [SWARM] Sending message to', connections.size, 'peers')
  for (const conn of connections) {
    conn.write(message)
  }
  emit('swarm:sent', { message })
}

// Heartbeat
setInterval(() => {
  console.log('JS: Heartbeat V13')
}, 5000)

// Signal that we are ready
emit('ready', { version: 13 })
