export function mashangConfig(businessRoot, stateDir) {
  return {
    businessRoot,
    stateDir,
    registry: 'mashang',
    definitions: ['business_definition', 'metrics', 'config_semantics'].map(id => ({
      id,
      path: `shared/schema/${id}.json`,
    })),
    registeredJobs: ['data-refresh-daily', 'data-refresh-config-attribute', 'data-refresh-lock-attribution'],
    freshness: {
      test_drive_data: 168,
      lock_attribution: 168,
      delivery_inventory: 168,
      store_info: 168,
      store_daily_leads: 168,
    },
  }
}
