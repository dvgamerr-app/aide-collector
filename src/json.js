export const parseJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value)
