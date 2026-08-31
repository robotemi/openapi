/** API hosts from temi-partner.openapi.yaml `servers`. */
export const ENVIRONMENTS = {
    production: 'https://api.robotemi.com/openapi/v1',
    integration: 'https://integration.dev.temi.cloud/openapi/v1',
}

export const SCOPE_LIST_ROBOTS = 'read:org:info'

/**
 * Single-robot GET resources. `scope` is the permission required by the spec.
 * Add a row here when a new read endpoint ships — the UI picks it up.
 */
export const ROBOT_RESOURCES = [
    {
        key: 'status',
        label: 'Status',
        scope: 'read:robot:status',
        path: (serialNumber) => `/robots/${encodeURIComponent(serialNumber)}`,
    },
    {
        key: 'locations',
        label: 'Locations',
        scope: 'read:robot:locations',
        path: (serialNumber) => `/robots/${encodeURIComponent(serialNumber)}/locations`,
    },
    {
        key: 'contacts',
        label: 'Contacts',
        scope: 'read:robot:contact',
        path: (serialNumber) => `/robots/${encodeURIComponent(serialNumber)}/contacts`,
    },
]

export function hasScope(scopes, required) {
    return Array.isArray(scopes) && scopes.includes(required)
}

export function permittedResources(scopes) {
    return ROBOT_RESOURCES.filter((resource) => hasScope(scopes, resource.scope))
}
