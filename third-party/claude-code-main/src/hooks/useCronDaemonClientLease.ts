import { useEffect } from 'react'
import {
  ensureTuiCronDaemonClientLease,
  stopTuiCronDaemonClientLease,
} from '../daemon/tuiClientLease.js'
import { getProjectRoot } from '../bootstrap/state.js'

export function useCronDaemonClientLease(): void {
  useEffect(() => {
    const projectRoot = getProjectRoot()
    ensureTuiCronDaemonClientLease(projectRoot)

    return () => {
      void stopTuiCronDaemonClientLease()
    }
  }, [])
}
