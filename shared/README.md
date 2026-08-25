# Shared message schemas

Frontend ve backend arasındaki sürümlenmiş mesaj sözleşmeleri burada tutulur. İlk iskelet
yalnızca `hello` mesajını kullanır; jest ve el landmark şemaları sonraki aşamada eklenecektir.
Makine tarafından okunabilir sözleşmeler `schemas/hello.schema.json` ve
`schemas/hands.schema.json` dosyalarındadır. `hands` mesajı en fazla iki el için 21 normalize
landmark, handedness skoru, frame kimliği ve backend işlem süresi taşır.

```json
{
  "schemaVersion": 1,
  "type": "hello",
  "message": "gesture-backend-ready",
  "timestamp": "2026-01-01T00:00:00+00:00"
}
```
