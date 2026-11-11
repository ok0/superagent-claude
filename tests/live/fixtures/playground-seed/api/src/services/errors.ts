export class ServiceError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export class ValidationError extends ServiceError {
  constructor(message: string) {
    super(400, 'invalid', message)
  }
}

export class UnauthorizedError extends ServiceError {
  constructor(message: string) {
    super(401, 'unauthorized', message)
  }
}

export class ForbiddenError extends ServiceError {
  constructor(message: string) {
    super(403, 'forbidden', message)
  }
}

export class NotFoundError extends ServiceError {
  constructor(message: string) {
    super(404, 'not_found', message)
  }
}
