import type { OsvaCodeApi } from '../../shared/api'

declare global {
  interface Window {
    api: OsvaCodeApi
  }
}

export {}
