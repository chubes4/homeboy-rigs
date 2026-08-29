# Markdown Database Integration Rigs

`mdi-sqlite` and `mdi-native` compare MDI's default SQLite runtime with the
verified native runtime using the same checkout, corpus, warmup, and in-tree
workloads.

```bash
homeboy rig install --all https://github.com/chubes4/homeboy-rigs.git//Automattic/markdown-database-integration

export HOMEBOY_RIG_COMPONENT_PATH__MDI_SQLITE__MARKDOWN_DATABASE_INTEGRATION=/path/to/markdown-database-integration
export HOMEBOY_RIG_COMPONENT_PATH__MDI_NATIVE__MARKDOWN_DATABASE_INTEGRATION=/path/to/markdown-database-integration

homeboy bench markdown-database-integration \
  --rig mdi-sqlite,mdi-native \
  --profile decision \
  --runs 5 \
  --iterations 30 \
  --warmup 5 \
  --report side-by-side \
  --run-id mdi-backend-comparison
```

The native rig's only backend-specific input is
`MARKDOWN_DB_BACKEND=mdi-native`. The SQLite rig leaves that constant undefined,
which exercises MDI's supported default runtime.
