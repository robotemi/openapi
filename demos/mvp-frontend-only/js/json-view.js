export function renderJson(container, value) {
    container.replaceChildren()
    container.classList.add('json-view')
    container.append(node(value, 0))
}

export function renderJsonOrText(container, value) {
    if (value !== null && typeof value === 'object') {
        renderJson(container, value)
        return
    }
    container.replaceChildren()
    container.classList.remove('json-view')
    const pre = document.createElement('pre')
    pre.textContent = value == null ? '' : String(value)
    container.append(pre)
}

export function renderError(container, error) {
    const status = error && error.status ? `${error.status} ` : ''
    const message = error && error.message ? error.message : String(error)
    container.replaceChildren()
    const line = document.createElement('p')
    line.textContent = `${status}${message}`.trim()
    container.append(line)
    if (error && error.body !== undefined && error.body !== null) {
        const body = document.createElement('div')
        container.append(body)
        renderJsonOrText(body, error.body)
    }
}

function node(value, depth) {
    if (value === null) {
        return leaf('null', 'json-null')
    }
    if (Array.isArray(value)) {
        return collection(value, depth, '[', ']', value.map((item) => ({ value: item })))
    }
    if (typeof value === 'object') {
        const items = Object.keys(value).map((key) => ({ key, value: value[key] }))
        return collection(value, depth, '{', '}', items)
    }
    if (typeof value === 'string') {
        return leaf(JSON.stringify(value), 'json-string')
    }
    if (typeof value === 'number') {
        return leaf(String(value), 'json-number')
    }
    if (typeof value === 'boolean') {
        return leaf(String(value), 'json-bool')
    }
    return leaf(String(value), 'json-unknown')
}

function collection(value, depth, open, close, items) {
    if (items.length === 0) {
        return leaf(open + close, 'json-punct')
    }

    const details = document.createElement('details')
    details.open = depth < 2
    const summary = document.createElement('summary')
    summary.append(leaf(open, 'json-punct'), leaf(close, 'json-punct'))
    details.append(summary)

    for (const item of items) {
        const row = document.createElement('div')
        if (item.key !== undefined) {
            row.append(leaf(JSON.stringify(item.key), 'json-key'), leaf(': ', 'json-punct'))
        }
        row.append(node(item.value, depth + 1))
        details.append(row)
    }
    details.append(leaf(close, 'json-punct'))
    return details
}

function leaf(text, className) {
    const span = document.createElement('span')
    span.className = className
    span.textContent = text
    return span
}
