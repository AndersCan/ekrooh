declare const BareKit: any

console.log('Hello Android notifications!')

BareKit.on('push', (payload: string, reply: (err: Error | null, res: string) => void) => {
  console.log('Notification received:', JSON.parse(payload))

  reply(
    null,
    JSON.stringify({
      title: 'Notification received',
      body: 'This is the body'
    })
  )
})
