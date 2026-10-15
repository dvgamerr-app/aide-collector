const running = new Set()

// Starts a fire-and-forget job unless one with the same name is still running; returns whether it started.
export const startExclusive = (name, job, onError) => {
  if (running.has(name)) return false
  running.add(name)
  Promise.resolve()
    .then(job)
    .catch(onError)
    .finally(() => running.delete(name))
  return true
}

export const alreadyRunning = (name) =>
  Response.json({ error: `${name} is already running; wait for it to finish`, success: false }, { status: 409 })
