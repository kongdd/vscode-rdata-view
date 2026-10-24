#!/usr/bin/env Rscript
# arf run data/generate-test-data.R
# 生成 ~100 MB 的 data.frame，并导出为各受支持格式
# %% 
pacman::p_load(data.table, fst, qs2, arrow)

# %%
set.seed(42)
n <- 2e6
sites <- sprintf("S%05d", 1:5e4)[sample.int(5e4, n, replace = TRUE)]
tags <- c("alpha", "beta", "gamma", "delta", NA_character_)

df <- data.frame(
  id = seq_len(n),
  site = sites,
  date = as.Date("1957-04-01") + sample.int(2e4, n, replace = TRUE),
  datetime = as.POSIXct("2020-01-01", tz = "UTC") + sample.int(1e8, n, replace = TRUE),
  temperature = round(rnorm(n, 10, 8), 2),
  value = rnorm(n, 1e3, 1e2),
  count = sample.int(1e6, n, replace = TRUE),
  flag = sample(c(TRUE, FALSE), n, replace = TRUE),
  label = factor(sample(tags[1:4], n, replace = TRUE)),
  note = tags,
  stringsAsFactors = FALSE
)
# 缺失值：数值列约 5%，字符列约 10%
df$temperature[sample.int(n, n %/% 20)] <- NA_real_
df$note[sample.int(n, n %/% 10)] <- NA_character_

cat(sprintf(
  "行数 %s，内存占用 %.1f MB\n", format(n, big.mark = ","),
  as.numeric(object.size(df)) / 1024^2
))

# %%
write_data <- function(df, file, write_fun = data.table::fwrite, ...) {
  t0 <- Sys.time()
  write_fun(df, file, ...)
  t_used <- as.numeric(Sys.time() - t0, units = "secs")

  cat(sprintf(
    "%-12s %6.1f MB  %5.1fs\n", basename(file),
    file.size(file) / 1024^2, t_used
  ))
}

write_data(df, "data/big.csv", data.table::fwrite)
write_data(df, "data/big.fst", fst::write_fst)
write_data(df, "data/big.qs2", qs2::qs_save)
write_data(df, "data/big.qdata", qs2::qd_save)
write_data(df, "data/big.rds", saveRDS)
write_data(df, "data/big.rda", \(df, file) save(df, file = file))

write_data(df, "data/big.arrow", arrow::write_ipc_file)
write_data(df, "data/big.feather", arrow::write_feather)
write_data(df, "data/big2.arrow", arrow::write_feather)
