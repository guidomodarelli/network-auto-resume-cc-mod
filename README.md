# network-auto-resume-cc-mod

Mod de Claude Code que retoma solo la respuesta cuando se corta por la red o por la API: un "error mid-response", un *Waiting for Network* que no se recupera, un 5xx o 529 de un proxy como CLI Proxy API.

## Cómo funciona

1. **Dentro del turno.** Si una petición al modelo falla antes de que llegue cualquier parte de la respuesta, el mod la reenvía enseguida (después de 0,75 s, hasta 2 veces), sin mandar ningún mensaje.
2. **Al terminar el turno con error.** Si igual se cortó, o si ya había llegado parte de la respuesta (reenviarla duplicaría el texto o la tool call), manda `go` al segundo. Si vuelve a fallar, espera 2 s, 4 s, 8 s y 16 s, y después del quinto intento seguido avisa con un toast.

Solo reintenta errores transitorios. Con el tipo que Claude Code le asigna a cada error (`StopFailure`), descarta los que fallarían igual en cada intento, avisa con un toast y no manda `go`: `invalid_request` (400, contexto lleno), `authentication_failed`, `billing_error`, `model_not_found`, entre otros. `server_error`, `overloaded`, `rate_limit` y los cortes de red sin tipo sí se reintentan.

El `go` es lo único que ves. El mod suma al system prompt una sección corta que le explica al modelo qué significa ese `go`: seguir donde quedó, sin repetir texto y sin volver a correr herramientas que ya corrieron.

Un turno que termina bien reinicia el contador. Con Esc o con un prompt tuyo se cancela el `go` pendiente. Los errores de los subagentes no se reintentan.

## Comando

```
/network-retry on | off | status
```

## Instalación

En el prompt de Claude Code:

```
/plugin install network-auto-resume-cc-mod --marketplace guidomodarelli/network-auto-resume-cc-mod
```

Respondé `y` para agregar el marketplace y elegí el scope. Desde una terminal:

```powershell
claude plugin install network-auto-resume-cc-mod --marketplace guidomodarelli/network-auto-resume-cc-mod
```

Para probar una copia local sin instalarla:

```powershell
claude --plugin-dir <carpeta del mod>
```

## Desarrollo

```powershell
claude plugin validate .
claude plugin test .
```

## Licencia

MIT. Ver [LICENSE](LICENSE).
