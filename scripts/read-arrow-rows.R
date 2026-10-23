#' Read a row range from a Parquet or Arrow IPC/Feather V2 file
#'
#' @param path Local file path.
#' @param skip Number of data rows to skip (zero-based offset).
#' @param nrows Maximum number of rows to return; Inf reads the remainder.
#' @param col_select A tidyselect expression; predicates use column prototypes.
#' @return A tibble. Only overlapping row groups/batches are decoded.
#' @examples
#' "data.parquet" |> read_arrow_rows(skip = 1000, nrows = 100,
#'   col_select = c(site, starts_with("Tair")))
read_arrow_rows <- function(path, skip = 0, nrows = Inf,
                            col_select = tidyselect::everything()) {
  stopifnot(
    is.numeric(skip), length(skip) == 1L, is.finite(skip), skip >= 0, skip == floor(skip),
    is.numeric(nrows), length(nrows) == 1L, nrows >= 0, nrows == floor(nrows)
  )
  parquet <- tolower(tools::file_ext(path)) %in% c("parquet", "pq")

  input <- arrow::ReadableFile$create(path)
  on.exit(input$close(), add = TRUE)
  reader <- if (parquet) arrow::ParquetFileReader$create(input) else {
    arrow::RecordBatchFileReader$create(input)
  }
  schema <- if (parquet) reader$GetSchema() else reader$schema
  prototype <- as.data.frame(arrow::Table$create(schema = schema))
  selected <- tidyselect::eval_select(
    rlang::enquo(col_select), prototype, allow_rename = FALSE
  )
  empty <- tibble::as_tibble(prototype[, names(selected), drop = FALSE])
  if (nrows == 0) return(empty)
  columns <- as.integer(selected) - 1L

  counts <- if (parquet) {
    # An empty column projection obtains row counts without decoding column data.
    vapply(seq_len(reader$num_row_groups) - 1L, function(i) {
      reader$ReadRowGroup(i, integer())$num_rows
    }, numeric(1))
  } else .ipc_row_counts(path)
  ends <- cumsum(counts)
  starts <- ends - counts
  groups <- which(ends > skip & starts < skip + nrows)
  parts <- lapply(groups, function(i) {
    batch <- if (parquet) reader$ReadRowGroup(i - 1L, columns) else {
      reader$get_batch(i - 1L)$SelectColumns(columns)
    }
    offset <- max(skip - starts[[i]], 0)
    size <- min(ends[[i]], skip + nrows) - starts[[i]] - offset
    tibble::as_tibble(batch$Slice(offset, size))
  })
  dplyr::bind_rows(empty, parts)
}

# R arrow exposes batch reads but not their row-count index. Read only IPC
# footer/message metadata here; Arrow itself handles schemas and decompression.
.ipc_row_counts <- function(path) {
  input <- file(path, "rb")
  on.exit(close(input), add = TRUE)
  size <- file.info(path)$size
  read_at <- function(offset, nbytes) {
    stopifnot(offset >= 0, nbytes >= 0, offset + nbytes <= size)
    seek(input, offset, origin = "start")
    readBin(input, "raw", n = nbytes)
  }
  uint <- function(bytes, offset, width) {
    stopifnot(offset >= 0, offset + width <= length(bytes))
    value <- sum(as.integer(bytes[offset + seq_len(width)]) * 256^(seq_len(width) - 1L))
    stopifnot(value <= 2^53 - 1)
    value
  }
  field <- function(bytes, table, index) {
    distance <- uint(bytes, table, 4L)
    if (distance >= 2^31) distance <- distance - 2^32
    vtable <- table - distance
    slot <- vtable + 4L + index * 2L
    if (slot >= vtable + uint(bytes, vtable, 2L)) return(NA_real_)
    offset <- uint(bytes, slot, 2L)
    if (offset == 0) NA_real_ else table + offset
  }

  footer_size <- uint(read_at(size - 10L, 4L), 0, 4L)
  footer <- read_at(size - 10L - footer_size, footer_size)
  slot <- field(footer, uint(footer, 0, 4L), 3L)
  if (is.na(slot)) return(numeric())
  vector <- slot + uint(footer, slot, 4L)
  blocks <- vector + 4L + (seq_len(uint(footer, vector, 4L)) - 1L) * 24L
  vapply(blocks, function(block) {
    message <- read_at(uint(footer, block, 8L), uint(footer, block + 8L, 4L))
    prefix <- if (all(message[1:4] == as.raw(255))) 8L else 4L
    root <- prefix + uint(message, prefix, 4L)
    header <- field(message, root, 2L)
    batch <- header + uint(message, header, 4L)
    rows <- field(message, batch, 0L)
    if (is.na(rows)) 0 else uint(message, rows, 8L)
  }, numeric(1))
}
