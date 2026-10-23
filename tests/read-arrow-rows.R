source("scripts/read-arrow-rows.R")
suppressPackageStartupMessages(library(dplyr))

dir <- tempfile("arrow-rows-")
dir.create(dir)
checks <- 0L
check <- function(actual, expected) {
  # Empty schema prototypes retain factor type, but have no dictionary values.
  if (is.data.frame(actual) && is.data.frame(expected) && nrow(actual) == 0 && nrow(expected) == 0) {
    expected <- expected |> mutate(across(where(is.factor), ~ factor(character(), ordered = is.ordered(.x))))
  }
  difference <- all.equal(actual, expected)
  if (!isTRUE(difference)) stop("Check ", checks + 1L, ": ", paste(difference, collapse = "; "))
  checks <<- checks + 1L
}
reject <- function(expr) {
  stopifnot(inherits(tryCatch(force(expr), error = identity), "error"))
  checks <<- checks + 1L
}

run <- function() {
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  table <- tibble(
    id = 1:11, value = seq(0.5, 5.5, 0.5),
    label = c("中文", "a,b", NA_character_, letters[4:11]),
    kind = factor(rep(c("a", "b"), length.out = 11)),
    date = as.Date("2025-01-01") + 0:10
  )
  for (format in c("parquet", "feather")) {
    for (compression in c("uncompressed", "zstd")) {
      path <- file.path(dir, paste0(format, "-", compression, ".", format))
      if (format == "parquet") {
        arrow::write_parquet(table, path, chunk_size = 4L, compression = compression)
        expected <- tibble::as_tibble(arrow::read_parquet(path))
      } else {
        arrow::write_feather(table, path, chunk_size = 4L, compression = compression)
        expected <- tibble::as_tibble(arrow::read_feather(path))
        check(.ipc_row_counts(path), c(4, 4, 3))
      }
      for (range in list(c(0, 2), c(3, 6), c(4, 4), c(10, 10), c(11, 5), c(99, 5), c(0, 0))) {
        skip <- range[[1L]]
        count <- max(0, min(range[[2L]], nrow(expected) - skip))
        rows <- if (count == 0) integer() else skip + seq_len(count)
        check(read_arrow_rows(path, skip, range[[2L]]), expected[rows, ])
      }
      check(read_arrow_rows(path, 3), expected[4:11, ])
      check(path |> read_arrow_rows(3, 6, c(label, id)), expected[4:9, c("label", "id")])
      check(read_arrow_rows(path, 3, 6, starts_with("la")), expected[4:9, "label", drop = FALSE])
      check(read_arrow_rows(path, 3, 6, where(is.numeric)), expected[4:9, c("id", "value")])
      check(read_arrow_rows(path, 3, 6, -c(kind, date, label)), expected[4:9, c("id", "value")])
      check(read_arrow_rows(path, 3, 6, integer()), expected[4:9, integer()])
      reject(read_arrow_rows(path, col_select = missing_column))
      reject(read_arrow_rows(path, col_select = c(renamed = id)))
    }
    path <- file.path(dir, paste0("empty.", format))
    if (format == "parquet") arrow::write_parquet(table[0, ], path) else {
      arrow::write_feather(table[0, ], path)
    }
    check(read_arrow_rows(path), table[0, ])
  }

  for (compression in c("lz4", "zstd", "uncompressed")) {
    path <- file.path("tests/fixtures", paste0(compression, ".feather"))
    if (!file.exists(path)) next
    expected <- tibble::as_tibble(arrow::read_feather(path))
    check(read_arrow_rows(path, 499, 10), expected[500:509, ])
  }
  path <- file.path(dir, "parquet-uncompressed.parquet")
  for (invalid in list(-1, 0.5, NA_real_, Inf, c(0, 1), "0", TRUE)) {
    reject(read_arrow_rows(path, skip = invalid))
  }
  for (invalid in list(-1, 0.5, NA_real_, -Inf, c(0, 1), "1", TRUE)) {
    reject(read_arrow_rows(path, nrows = invalid))
  }
  reject(read_arrow_rows("table.csv"))
  reject(read_arrow_rows(c(path, path)))
  reject(read_arrow_rows(file.path(dir, "missing.arrow")))

  large <- Sys.getenv("RDATA_TEST_ARROW")
  if (nzchar(large)) {
    total <- sum(.ipc_row_counts(large))
    elapsed <- system.time(page <- read_arrow_rows(large, skip = total - 2, nrows = 2,
                                                  col_select = c(site, date)))
    check(nrow(page), 2L)
    check(names(page), c("site", "date"))
    cat("Large-file final page:", elapsed[["elapsed"]], "seconds\n")
  }
  cat("ARROW_ROWS_TESTS_OK", checks, "checks\n")
}
run()
