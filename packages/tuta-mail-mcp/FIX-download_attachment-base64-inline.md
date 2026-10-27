# Fix: `download_attachment` devolvía base64 inline (frágil)

Estado: **hecho y desplegado** (2026-10-27).

## Contexto

Para leer un `.docx` / `.doc` / `.pdf`, el agente tenía que **re-emitir** el base64
hacia una herramienta externa (`base64 -d`, `pandoc`, `python`). Ese round-trip se
trunca o se corrompe. En el host no hay forma de pasar el resultado de una
herramienta por referencia: cualquier byte que el modelo quiera reutilizar tiene
que volver a escribirlo.

Caso real (2026-10-27): `Mandat secrétariat UT.docx` (17 294 bytes) llegó como
base64 (~23 KB). El agente no pudo re-emitirlo; la extracción falló.

## Diagnóstico

El fallo no es de presupuesto de contexto: el base64 llega completo. Falla el
formato intermedio, porque el modelo tiene que copiarlo. Por eso no sirve un
umbral (un borrador local partía en 48 KB y el caso de 17 KB seguía saliendo
inline), ni bajarlo a unos pocos KB: la copia se corrompe mucho antes.

## Diseño final

Todo adjunto se escribe a disco. La respuesta es:

```json
{ "account", "filename", "contentType", "sizeBytes", "savedPath" }
```

Sin `contentBase64` y sin `contentText`: un único camino. Un `.txt` pequeño
también va a disco y el agente lo lee con `cat`.

- **Directorio:** `MAIL_API_ATTACHMENT_DIR`, leído en `loadConfig` y resuelto a
  ruta absoluta (`~/` se expande). Por defecto
  `~/.local/share/tuta-mail/attachments`. El home y `/` se rechazan al arrancar.
- **Permisos:** archivos `0600`. Un directorio que el servidor crea queda `0700`.
  Un directorio existente solo se ajusta a `0700` si es el de por defecto (una vez
  por proceso, ignorando `EPERM`); uno configurado por el operador conserva su modo.
- **Nombre:** `<16 hex de sha256(cuenta, mensaje, adjunto)>-<nombre saneado>`.
  - Solo `[A-Za-z0-9._-]` (acentos, espacios y paréntesis → `_`), así que el
    nombre es una palabra de shell y no puede contener separadores. El directorio
    no está restringido: `savedPath` va **entre comillas** en la shell.
  - La extensión se conserva al truncar a 180 caracteres y, si falta, se deduce
    del `contentType` (un `Map`, inmune a claves del prototipo).
  - El campo `filename` del JSON conserva el nombre original.
- **Escritura:** a un temporal y `rename`; si falla, el temporal se borra.
- **Copias:** la clave es estable, así que descargar de nuevo el mismo adjunto
  reemplaza su archivo y borra copias del mismo adjunto con un nombre anterior.
  Adjuntos distintos se acumulan: la limpieza es manual.

El agente convierte con el toolchain de `org/research`: `./docx2md.sh "<savedPath>"`
o `pandoc -t plain "<savedPath>"` (`.pdf` con `pdftotext`).

### No hacer

- No convertir a Markdown/texto dentro del MCP (`mammoth`, LibreOffice,
  `pdftotext`): duplica `docx2md.sh` y mete dependencias en el servidor.
- `send_message` también tiene `contentBase64`, pero es de entrada (el adjunto
  que se envía). No entra en este cambio.

### Relación con el arreglo de nombres

`4cef50e83` (*Fix attachment downloads whose filenames are not ASCII*) es aparte:
el bridge manda `filename` ASCII más `filename*` (RFC 5987) y el cliente MCP se
queda con `filename*`. Sin eso, un nombre con acento era HTTP 500 después de
descifrar. El saneado del nombre en disco es otra capa.

## Commits (`feat/tuta-mail-bridge-mcp`)

| Commit | Qué |
|---|---|
| `42f4d17f7` | Guardar siempre a disco; quitar `contentBase64` de la respuesta. |
| `dacd51901` | Permisos `0700`/`0600`, nombre por hash de ids, escritura atómica, extensión desde `contentType`, `attachmentDir` en `McpConfig`, tests de saneado. |
| `ba8a56fa7` | Nombre restringido a `[A-Za-z0-9._-]`, `~/` en la config, protección contra claves del prototipo. |
| `8bc9721fe` | `chmod` solo del directorio por defecto, rechazo de home y `/`, limpieza de copias con nombre anterior, `AttachmentStore`, `npm test` con type-check de los tests. |

Dos revisiones de código (sobre `42f4d17f7` y `ba8a56fa7`) encontraron 8 problemas
cada una; todos quedaron corregidos en el commit siguiente. Tests: 52/52.

## Despliegue

- **Local:** Zed y opencode apuntan a `packages/tuta-mail-mcp/dist/index.js` de este
  checkout; no hubo que cambiar su configuración. `~/.local/share/tuta-mail` y
  `attachments` ajustados a mano a `0700` y los archivos existentes a `0600`.
- **baggy:** `~/src/tutanota` en `8bc9721fe`, compilado, tests 52/52.
  - Hermes (`~/.hermes/config.yaml`) ya apuntaba ahí. `hermes-gateway` y
    `hermes-serve` reiniciados; verificado por stdio que el MCP expone la nueva
    descripción y que las 6 cuentas responden `ready=true`.
  - opencode (`~/.config/opencode/opencode.json`) apuntaba a una copia suelta
    `~/projects/tuta-mail-mcp` (v341, todavía con base64). Ahora apunta a
    `~/src/tutanota/...`; backup en `opencode.json.bak-tuta-mail-20261027`.
  - `tuta_monitor.py` (cron) llama directo a la API REST, no al MCP: no le afecta.
- **Runbook:** `TUTA-MAIL-MCP-RUNBOOK.md` en `org/research` (baggy) actualizado
  en `2df2fea` (§5, flujo de lectura y convenciones de guardado).

## Pendiente

- [ ] Reiniciar `opencode serve --service` en baggy (lanzado a mano, sin unit de
      systemd) y los MCP locales de Zed y opencode, para que tomen el nuevo `dist/`.
- [ ] Borrar la copia vieja `~/projects/tuta-mail-mcp` en baggy cuando opencode
      funcione con la ruta nueva.
- [ ] Borrar en local los dos `.docx` con el prefijo viejo (`1792465223-…`): la
      limpieza automática no los reconoce.
