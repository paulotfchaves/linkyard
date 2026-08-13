// Temporary surface: proves the token layer, the fonts, and the two worlds
// (ember panel over light working surface) render before any real screen is
// built on top of them. Replaced by the sign-in route in Task 6.
export default function TokensPreview() {
  return (
    <>
      <header className="ember shell__bar">
        <span className="t-label" style={{ color: 'var(--on-panel)' }}>
          Linkyard
        </span>
        <span className="t-label" style={{ color: 'var(--on-panel-muted)' }}>
          token preview
        </span>
      </header>

      <main className="shell__main" style={{ paddingTop: '2rem' }}>
        <h1 className="t-display">
          The Ember <span className="t-script">Workbench</span>
        </h1>
        <p className="t-prose t-muted" style={{ marginTop: '1rem' }}>
          Light working surface, ember panels as punctuation, hairlines instead of shadows.
        </p>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '2rem', flexWrap: 'wrap' }}>
          <button className="btn btn--primary">
            Create link <span className="btn__arrow">↗</span>
          </button>
          <button className="btn btn--quiet">Cancel</button>
          <button className="btn btn--danger btn--small">Delete domain</button>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
          <span className="badge badge--active">Active</span>
          <span className="badge badge--scheduled">Scheduled</span>
          <span className="badge badge--paused">Paused</span>
          <span className="badge badge--expired">Expired</span>
          <span className="tag">launch</span>
        </div>

        <div className="card" style={{ marginTop: '2rem', overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Destination</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Clicks</th>
              </tr>
            </thead>
            <tbody>
              <tr data-selected="true">
                <td className="mono">go.example.com/spring</td>
                <td className="t-muted">https://example.com/spring-campaign</td>
                <td>
                  <span className="badge badge--active">Active</span>
                </td>
                <td className="tabular" style={{ textAlign: 'right' }}>
                  12,481
                </td>
              </tr>
              <tr>
                <td className="mono">go.example.com/webinar</td>
                <td className="t-muted">https://example.com/webinar</td>
                <td>
                  <span className="badge badge--scheduled">Scheduled</span>
                </td>
                <td className="tabular" style={{ textAlign: 'right' }}>
                  3,904
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </main>
    </>
  )
}
