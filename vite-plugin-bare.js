import Sidecar from 'bare-sidecar'
import path from 'path'
import { execSync } from 'child_process'

export default function barePlugin() {
  let sidecar = null
  let viteServer = null

  return {
    name: 'bare-plugin',
    configureServer(server) {
      viteServer = server
      const bareAppPath = path.resolve(process.cwd(), 'core/app.gen.js')

      console.log('[vite] Building Bare core...')
      try {
        execSync('npm run build:bare', { stdio: 'inherit' })
      } catch (err) {
        console.error('[vite] Build failed:', err.message)
      }

      console.log('[vite] Starting Bare sidecar...')
      sidecar = new Sidecar(bareAppPath)

      sidecar.on('data', (data) => {
        const str = data.toString()
        // Relay the raw string to the web side.
        // web/main.js expects a JSON string in 'result'.
        viteServer?.hot.send('bare:event', { result: str })
      })

      sidecar.on('error', (err) => {
        console.error('[vite] Sidecar error:', err)
      })

      sidecar.on('exit', (code) => {
        console.log(`[vite] Bare sidecar exited with code ${code}`)
      })

      server.hot.on('bare:request', (data) => {
        if (sidecar) {
          // data.payload is the JSON string from the web side
          sidecar.write(data.payload)
        }else {
          console.warn('[vite] Sidecar is not running. Cannot send data.')
        }
      })

      server.httpServer?.on('close', () => {
        if (sidecar) {
          sidecar.destroy()
          sidecar = null
        }
      })
    }
  }
}
