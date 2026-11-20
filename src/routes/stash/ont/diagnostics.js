/** Keep response shape and session context without exporting payload values or credentials. */
export const hostResponseDetails = ({ httpStatus, now, openedAt, pageUrl, result }) => {
  const url = new URL(pageUrl)
  return {
    data_type: result?.data === null ? 'null' : typeof result?.data,
    http_status: httpStatus,
    page_url: `${url.origin}${url.pathname}`,
    response_code: Number.isSafeInteger(result?.code) ? result.code : undefined,
    response_keys:
      result && typeof result === 'object'
        ? Object.keys(result)
            .filter((key) => !/pass|token|cookie|auth|session|secret/i.test(key))
            .slice(0, 20)
            .map((key) => key.slice(0, 64))
        : [],
    response_type: result === null ? 'null' : typeof result,
    session_age_ms: openedAt === null ? null : Math.round(now - openedAt),
  }
}
