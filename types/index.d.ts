export type MascotIsWorking = boolean

declare module 'claude-code' {
  interface PluginState {
    'piksel-maskot': { isWorking: MascotIsWorking }
  }
}
