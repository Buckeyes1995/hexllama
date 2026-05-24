// Shared registry of user-started llama-server cards. The router consults this
// before spawning its own slot — if a card is already serving the requested
// model file, the router proxies to that port instead of double-loading the
// model into unified memory.

import type { ChildProcess } from 'child_process'
import { resolve } from 'path'

interface RunningCard {
  proc: ChildProcess
  port: number
  modelPath: string  // absolute, resolve()-normalized
}

const cards = new Map<string, RunningCard>()

export function setRunningCard(id: string, proc: ChildProcess, port: number, modelPath: string): void {
  cards.set(id, { proc, port, modelPath: resolve(modelPath) })
}

export function removeRunningCard(id: string): void {
  cards.delete(id)
}

export function hasRunningCard(id: string): boolean {
  return cards.has(id)
}

export function getRunningCardProc(id: string): ChildProcess | undefined {
  return cards.get(id)?.proc
}

// Router uses this to skip spawning a duplicate. Returns the first live card
// whose modelPath matches; callers should treat the result as read-only.
export function findRunningCardForModel(modelPath: string): RunningCard | null {
  const target = resolve(modelPath)
  for (const card of cards.values()) {
    if (card.modelPath !== target) continue
    if (card.proc.killed || card.proc.exitCode !== null) continue
    return card
  }
  return null
}

export function extractModelPathFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-m' || args[i] === '--model') return args[i + 1]
  }
  return null
}
