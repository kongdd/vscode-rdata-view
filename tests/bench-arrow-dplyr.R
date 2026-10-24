# arf --vanilla -f tests/bench-arrow-dplyr.R
options(error = function() quit(status = 1))
source("scripts/bench-arrow-dplyr.R")

run_tests <- function() {
  dir <- tempfile("arrow-dplyr-")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  df <- tibble(
    id = 1:23, site = rep(c("中文", "A", NA_character_), length.out = 23),
    date = as.Date("2025-01-01") + 0:22,
    temperature = rep(c(NA_real_, 9, 12, 15), length.out = 23),
    flag = rep(c(TRUE, FALSE, NA), length.out = 23)
  )
  checks <- 0L
  for (compression in c("uncompressed", "lz4", "zstd")) {
    file <- file.path(dir, paste0(compression, ".feather"))
    arrow::write_feather(df, file, chunk_size = 4L, compression = compression)
    dataset <- arrow::open_dataset(file, format = "ipc")
    query <- dataset |>
      filter(!is.na(temperature), temperature > 10, flag) |>
      select(id, site, date, temperature)
    expected <- df |>
      filter(!is.na(temperature), temperature > 10, flag) |>
      select(id, site, date, temperature)
    for (filtered in c(FALSE, TRUE)) {
      source <- if (filtered) query else dataset
      reference <- if (filtered) expected else df
      for (range in list(c(0, 3), c(3, 6), c(4, 4), c(22, 10), c(23, 5), c(99, 5), c(0, 0))) {
        skip <- range[[1L]]
        size <- range[[2L]]
        rows <- skip + seq_len(max(0, min(size, nrow(reference) - skip)))
        difference <- all.equal(read_query_rows(source, skip, size), reference[rows, ])
        if (!isTRUE(difference)) {
          stop(compression, " filtered=", filtered, " skip=", skip, " size=", size,
               ": ", paste(difference, collapse = "; "))
        }
        checks <- checks + 1L
      }
    }
    empty_query <- dataset |> filter(id < 0)
    stopifnot(isTRUE(all.equal(read_query_rows(empty_query), df[0, ])))
    empty_file <- file.path(dir, "empty.feather")
    arrow::write_feather(df[0, ], empty_file, compression = compression)
    stopifnot(isTRUE(all.equal(
      read_query_rows(arrow::open_dataset(empty_file, format = "ipc")), df[0, ]
    )))
    samples <- bench_arrow_dplyr(file, repeats = 1L, page_rows = 3L)
    stopifnot(nrow(samples) == 11L, all(is.finite(samples$elapsed_ms)))
    checks <- checks + 3L
  }
  cat("ARROW_DPLYR_TESTS_OK", checks, "checks\n")
}
run_tests()
