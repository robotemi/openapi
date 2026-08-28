/**
 * Browser client for Partner OpenAPI. The OAT is sent only as `x-api-key`
 * to the selected temi host — never to another origin.
 */
export function createClient({ baseUrl, token }) {
    async function request(path) {
        const response = await fetch(`${baseUrl}${path}`, {
            redirect: 'error',
            headers: {
                Accept: 'application/json',
                'x-api-key': token,
            },
        })

        const text = await response.text()
        let body = null
        if (text) {
            try {
                body = JSON.parse(text)
            } catch {
                body = text
            }
        }

        if (!response.ok) {
            const error = new Error(messageFromBody(body, response.statusText))
            error.status = response.status
            error.body = body
            throw error
        }

        return body
    }

    return {
        verify: () => request('/verify'),
        listRobots: () => request('/robots'),
        get: (path) => request(path),
    }
}

function messageFromBody(body, fallback) {
    if (body && typeof body === 'object' && typeof body.error === 'string') {
        return body.error
    }
    return fallback || 'request failed'
}
