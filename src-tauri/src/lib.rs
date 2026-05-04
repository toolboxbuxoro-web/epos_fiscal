use tauri_plugin_sql::{Migration, MigrationKind};

mod printer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: include_str!("../migrations/001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create_logs_table",
            sql: include_str!("../migrations/002_logs.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "inventory_sync_pending_confirms",
            sql: include_str!("../migrations/003_inventory_sync.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:epos_fiscal.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            printer::list_printers,
            printer::print_test_qr,
            printer::print_fiscal_receipt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
