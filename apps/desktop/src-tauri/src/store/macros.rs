//! Store macros (declared before the other modules via `#[macro_use]`).

/// `Debug` that only shows non-sensitive fields, so the rest (addresses, names, subjects, MIME, payloads) never
/// reaches a log through `{:?}`.
macro_rules! opaque_debug {
    ($type:ident { $($field:ident),* $(,)? }) => {
        impl std::fmt::Debug for $type {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.debug_struct(stringify!($type))
                    $(.field(stringify!($field), &self.$field))*
                    .finish_non_exhaustive()
            }
        }
    };
}

/// Rust enum ↔ SQL text, with `ToSql`/`FromSql`. Unknown text is a read error. `ALL` lists the variants (tests
/// check the schema's `CHECK` accepts all of them).
macro_rules! sql_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "lowercase")]
        pub enum $name { $($variant),+ }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
        }

        impl ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }

        impl FromSql for $name {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                match value.as_str()? {
                    $($text => Ok(Self::$variant),)+
                    _ => Err(FromSqlError::InvalidType),
                }
            }
        }
    };
}

/// SQL condition: the row (its `addr_key` column) does not belong to an abandoned address. Rows of abandoned addresses
/// are hidden from the app, not deleted.
macro_rules! visible {
    () => {
        "addr_key NOT IN (SELECT addr_key FROM addresses WHERE abandoned_at IS NOT NULL)"
    };
}
