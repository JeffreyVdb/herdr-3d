Done: the CSV exporter now streams rows instead of building the whole file in memory, and the 2 GB export that used to OOM finishes in 40 s with 60 MB RSS.

Next steps, whenever convenient:
- Port the XLSX exporter to the same streaming writer.
- Add a benchmark for the 1M-row case to CI.
- Remove the old `buildCSV` helper once nothing calls it.
