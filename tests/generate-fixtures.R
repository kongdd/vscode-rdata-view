dir <- Sys.getenv("RDATA_TEST_DIR")
table <- data.frame(
  id = 1:1100, text = rep(c("中文", "a,b", "line\n2", NA_character_), 275),
  flag = rep(c(TRUE, FALSE), 550),
  date = as.Date("2025-01-01") + 0:1099,
  group = factor(rep(c("a", "b"), 550))
)
saveRDS(table, file.path(dir, "table.rds"))
data.table::fwrite(table, file.path(dir, "table.csv"))
qs2::qs_save(table, file.path(dir, "table.qs2"))
qs2::qd_save(table, file.path(dir, "table.qdata"))
fst::write_fst(table, file.path(dir, "table.fst"))
fst::write_fst(table[0, ], file.path(dir, "empty.fst"))
env <- new.env()
env[["中文 ' object"]] <- table
env[["matrix"]] <- matrix(1:6, nrow = 2)
env[["not_table"]] <- 42
save(list = ls(env), envir = env, file = file.path(dir, "objects.rda"))
# qs_savem() 会保留变量名，可用于验证多对象 qs2。
number <- 42
qs2::qs_savem(number, table, file = file.path(dir, "objects.qs2"))
saveRDS(42, file.path(dir, "scalar.rds"))
nested <- data.frame(id = 1:2)
nested$items <- list(c(1, 2), list(a = TRUE))
saveRDS(nested, file.path(dir, "nested.rds"))
