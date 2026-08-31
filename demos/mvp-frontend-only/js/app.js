import { createClient } from './api.js'
import {
    ENVIRONMENTS,
    ROBOT_RESOURCES,
    SCOPE_LIST_ROBOTS,
    hasScope,
    permittedResources,
} from './config.js'
import { renderError, renderJson, renderJsonOrText } from './json-view.js'

const els = {
    env: document.getElementById('env'),
    token: document.getElementById('token'),
    verify: document.getElementById('verify'),
    clear: document.getElementById('clear'),
    verifyError: document.getElementById('verify-error'),
    verifyOut: document.getElementById('verify-out'),
    verifyMeta: document.getElementById('verify-meta'),
    robotsSection: document.getElementById('robots-section'),
    robotsNote: document.getElementById('robots-note'),
    robotsList: document.getElementById('robots-list'),
    resourcesSection: document.getElementById('resources-section'),
    resourcesOut: document.getElementById('resources-out'),
}

let session = {
    client: null,
    scopes: [],
}

els.verify.addEventListener('click', onVerify)
els.clear.addEventListener('click', onClear)
els.token.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault()
        onVerify()
    }
})

async function onVerify() {
    const token = els.token.value.trim()
    const env = els.env.value
    const baseUrl = ENVIRONMENTS[env]

    resetResults()

    if (!token) {
        showError('Enter an Organization Access Token.')
        return
    }

    if (!baseUrl) {
        showError('Unknown environment.')
        return
    }

    session.client = createClient({ baseUrl, token })
    els.verify.disabled = true

    try {
        const verify = await session.client.verify()
        session.scopes = Array.isArray(verify.scopes) ? verify.scopes : []
        renderVerify(verify)
        await renderRobots(verify)
    } catch (error) {
        showError(formatError(error))
        session.client = null
        session.scopes = []
    } finally {
        els.verify.disabled = false
    }
}

function onClear() {
    els.token.value = ''
    els.env.value = 'production'
    session.client = null
    session.scopes = []
    resetResults()
}

async function renderRobots(verify) {
    els.robotsSection.hidden = false

    if (hasScope(session.scopes, SCOPE_LIST_ROBOTS)) {
        els.robotsNote.textContent = `GET /robots (${SCOPE_LIST_ROBOTS}). robotScope=${verify.robotScope || 'n/a'}`
        try {
            const data = await session.client.listRobots()
            const robots = Array.isArray(data && data.robots) ? data.robots : []
            fillRobotList(robots)
            return
        } catch (error) {
            els.robotsNote.textContent = `GET /robots failed: ${formatError(error)}`
            fillRobotList(serialsAsRobots(verify.serialNumbers))
            return
        }
    }

    const fallback = serialsAsRobots(verify.serialNumbers)
    if (fallback.length) {
        els.robotsNote.textContent =
            `Missing ${SCOPE_LIST_ROBOTS}. Showing serialNumbers from /verify (robotScope=${verify.robotScope || 'selected'}).`
        fillRobotList(fallback)
        return
    }

    els.robotsNote.textContent =
        `Token has no ${SCOPE_LIST_ROBOTS}, and /verify did not return serialNumbers.`
    els.robotsList.textContent = ''
}

function fillRobotList(robots) {
    els.robotsList.textContent = ''

    if (!robots.length) {
        els.robotsList.textContent = 'No robots.'
        return
    }

    const permitted = permittedResources(session.scopes)
    for (const robot of robots) {
        const row = document.createElement('p')
        const label = document.createElement('span')
        label.textContent = robotLine(robot) + ' '

        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = 'Load permitted resources'
        button.disabled = permitted.length === 0 || !hasSerialNumber(robot)
        button.addEventListener('click', () => onLoadResources(robot))

        row.append(label, button)
        els.robotsList.append(row)
    }

    if (permitted.length === 0) {
        const note = document.createElement('p')
        note.textContent = `No single-robot read scopes. Need one of: ${ROBOT_RESOURCES.map((r) => r.scope).join(', ')}`
        els.robotsList.append(note)
    }
}

async function onLoadResources(robot) {
    if (!hasSerialNumber(robot)) {
        return
    }
    const serialNumber = robot.serialNumber
    els.resourcesSection.hidden = false
    els.resourcesOut.textContent = ''

    const heading = document.createElement('p')
    heading.textContent = robotLine(robot)
    els.resourcesOut.append(heading)

    for (const resource of ROBOT_RESOURCES) {
        const block = document.createElement('section')
        const title = document.createElement('p')

        if (!hasScope(session.scopes, resource.scope)) {
            title.textContent = `${resource.label} — skipped (missing ${resource.scope})`
            block.append(title)
            els.resourcesOut.append(block)
            continue
        }

        title.textContent = `${resource.label} — GET ${resource.path(serialNumber)} (${resource.scope})`
        const body = document.createElement('div')
        try {
            const data = await session.client.get(resource.path(serialNumber))
            renderJsonOrText(body, data)
        } catch (error) {
            renderError(body, error)
        }
        block.append(title, body)
        els.resourcesOut.append(block)
    }
}

function renderVerify(verify) {
    els.verifyOut.hidden = false
    renderJson(els.verifyMeta, {
        status: verify.status,
        organizationId: verify.organizationId,
        tokenId: verify.tokenId,
        scopes: verify.scopes,
        robotScope: verify.robotScope,
        serialNumbers: verify.serialNumbers,
    })
}

function resetResults() {
    els.verifyError.hidden = true
    els.verifyError.textContent = ''
    els.verifyOut.hidden = true
    els.verifyMeta.replaceChildren()
    els.robotsSection.hidden = true
    els.robotsNote.textContent = ''
    els.robotsList.textContent = ''
    els.resourcesSection.hidden = true
    els.resourcesOut.textContent = ''
}

function showError(message) {
    els.verifyError.hidden = false
    els.verifyError.textContent = message
}

function serialsAsRobots(serialNumbers) {
    if (!Array.isArray(serialNumbers)) {
        return []
    }
    return serialNumbers.map((serialNumber) => ({ serialNumber }))
}

function hasSerialNumber(robot) {
    return Boolean(robot && typeof robot.serialNumber === 'string' && robot.serialNumber.trim())
}

function robotLine(robot) {
    const name = robot.teminame ? `${robot.teminame} ` : ''
    return `${name}${robot.serialNumber || '(missing serialNumber)'}`
}

function formatError(error) {
    const status = error && error.status ? `${error.status} ` : ''
    const message = error && error.message ? error.message : String(error)
    return `${status}${message}`.trim()
}
