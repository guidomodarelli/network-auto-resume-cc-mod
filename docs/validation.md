# Validación de la reanudación automática

Registro de lo comprobado fuera de los tests: que el mod manda el mensaje de reanudación después de un corte y que el turno sigue sin que nadie escriba nada.

## v0.5.0 (`97f4a6e`)

Evidencia completa y pasos de reproducción: [gist de la validación](https://gist.github.com/guidomodarelli/5704d948249604bff7f0de7d83864373). La prueba aislada corrió con Claude Code 2.1.327.

| Prueba | Resultado |
| --- | --- |
| Suite del mod (`claude plugin test`) | ✅ 21 tests aprobados, 0 fallidos. |
| API local simulada | ✅ Después de texto parcial, la API devolvió un error SSE `overloaded_error` a mitad de la respuesta. La segunda solicitud, con la instrucción de reanudación, llegó **1,08 s** después, sin intervención. La terminal mostró «✅ Respuesta retomada tras 1 reintento». |
| CLI Proxy API real | ✅ Después de un corte natural (no provocado), Claude Code mostró el mensaje «Tu respuesta anterior se cortó… Seguí donde quedaste…» atribuido al mod. Ese mensaje abrió un turno nuevo y el asistente respondió. |

### Cómo repetirla

1. Cargar la versión a validar y revisar `/network-retry status`.
2. En una sesión aislada contra una API de prueba, responder la primera solicitud con texto parcial y después un error SSE `overloaded_error`, y la siguiente con una respuesta normal. No escribir un segundo mensaje.
3. Verificar que la segunda solicitud trae la instrucción de reanudación y que, cuando la respuesta termina, la terminal muestra el aviso de recuperación.
4. Con un proxy real, esperar un corte natural y buscar el mensaje atribuido al mod.

`Waiting for API response` y los demás avisos de espera son de Claude Code, no del mod: no prueban que el mod se haya activado. La evidencia es el mensaje de reanudación atribuido al mod.

### Límites

- **`classic.StopFailure` omitido.** En los dos casos, el plugin `cc-plugin-sec-default` de Claude Code omitió el hook `classic.StopFailure` del mod. Los reintentos funcionaron igual, pero sin ese hook el mod no conoce el tipo de error: lo reintenta como transitorio, hasta el tope de 5. Con el hook omitido no quedó validado que cada tipo de error se clasifique bien; por ejemplo, un error de credenciales también se reintentaría.
- **La latencia es del entorno local.** El 1,08 s se midió contra la API simulada; con el proxy real no se midió.
- **Qué no se registró.** No hay credenciales, endpoints privados ni logs de sesión.
