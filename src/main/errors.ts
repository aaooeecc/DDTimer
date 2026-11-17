import type { Message } from '../shared/language'

export class OperationError extends Error {
  constructor(readonly code: string, readonly message: Message, readonly retryable = false) {
    super(message)
  }
}
