# 🎰 CASINO CHAOS

Party game arcade de casino: una PC hace de servidor y cada persona juega desde el navegador de su celular, conectada al mismo Wi-Fi. **Todo es ficticio: no hay dinero real, depósitos ni retiros.**

- 6 minijuegos: Lucky Spin, Ruleta del Caos, Quick Draw, Alto o Bajo, Smash Cash, Cofres Malditos.
- Salas privadas con código (2 a 8 jugadores), apuestas con monedas ficticias, clasificación en vivo y podio final.
- Gemas (solo se ganan jugando) para comprar cosméticos en la tienda. Perfil y compras se guardan en SQLite.
- Funciona sin Internet una vez instaladas las dependencias.

---

## Instalación y uso en Windows (paso a paso)

### 1. Instalar Node.js
1. Entrá a https://nodejs.org y descargá la versión **LTS** (necesitás Node **22 o superior**).
2. Instalala con las opciones por defecto.
3. Para comprobarlo (después del paso 2) escribí `node -v`: tiene que mostrar `v22...` o más.

### 2. Abrir una terminal en la carpeta del proyecto
1. Descomprimí el proyecto (carpeta `casino-chaos`).
2. Abrí esa carpeta en el Explorador de archivos, hacé clic en la barra de direcciones, escribí `cmd` y apretá Enter.

### 3. Instalar dependencias
```
npm install
```
Solo la primera vez; necesita Internet. `better-sqlite3` trae su binario ya compilado para Windows.

### 4. Iniciar el servidor
```
npm start
```
Vas a ver algo así:
```
En esta PC:        http://localhost:3000
Desde celulares:   http://192.168.1.100:3000   (Wi-Fi)
```

### 5. Abrir el juego en la PC
Abrí `http://localhost:3000` en el navegador. Ahí podés jugar vos también.

### 6. Obtener la IP local de la PC
El servidor ya imprime las direcciones. Para comprobarlo a mano: en una terminal escribí `ipconfig` y buscá **Dirección IPv4** del adaptador Wi-Fi (por ejemplo `192.168.1.100`). **Esa IP es solo un ejemplo: la tuya será otra.**

### 7. Conectar los celulares
1. Los celulares tienen que estar en el **mismo Wi-Fi** que la PC.
2. En el navegador del celular abrí `http://IP-DE-LA-PC:3000` (con la IP del paso 6, **nunca `localhost`**).
3. Comprobá la conectividad abriendo `http://IP-DE-LA-PC:3000/api/health`: tiene que mostrar `{"ok":true,...}`.
4. El anfitrión toca **Jugar → Crear sala** y comparte el código (Copiar / Compartir). Los demás tocan **Jugar → Unirme** e ingresan el código.

### 8. Permitir Node.js en el Firewall de Windows
La primera vez que ejecutes `npm start`, Windows muestra un aviso del Firewall: marcá **Redes privadas** y tocá **Permitir acceso**.

Si lo cerraste sin querer: Panel de control → Sistema y seguridad → Firewall de Windows Defender → *Permitir una aplicación…* → *Cambiar la configuración* → **Node.js JavaScript Runtime** → tildá **Privada**.
Alternativa (terminal como administrador):
`netsh advfirewall firewall add rule name="Casino Chaos" dir=in action=allow protocol=TCP localport=3000 profile=private`

### 9. Detener el servidor
En la terminal donde corre, apretá `Ctrl + C`.

### 10. Problemas frecuentes
| Problema | Solución |
|---|---|
| El celular no abre la página | Mismo Wi-Fi, IP correcta (no `localhost`) y firewall (paso 8). |
| Funciona en la PC pero no en el celular | Algunas redes de invitados o puntos de acceso tienen **aislamiento de clientes**. Probá otro Wi-Fi o usá el celular como punto de acceso. |
| `El puerto 3000 ya está en uso` | Cerrá la otra instancia o usá otro puerto: `set PORT=3001 && npm start` (y `:3001` en las direcciones). |
| `npm` o `node` no se reconoce | Reinstalá Node.js y abrí una terminal nueva. |
| Error al instalar `better-sqlite3` | Verificá Node 22+ e Internet durante `npm install`. |
| Aparece "Reconectando…" | Se perdió el Wi-Fi: el juego reintenta solo y te devuelve a tu sala. |
| Sin sonido | Tocá la pantalla una vez (lo exigen los navegadores) y revisá ⚙ Ajustes y el volumen del celular. |

---

## Cómo se juega
Cada ronda: **anuncio → apuestas → cuenta regresiva → minijuego → resultados**. Todos empiezan con 1.000 monedas (configurable). Gana quien termine con más monedas; desempata quien ganó más rondas; si persiste, es empate.

| Minijuego | Reglas resumidas |
|---|---|
| 🎰 Lucky Spin (casa) | Tres iguales pagan ×4 a ×100; pareja ×1 (cereza) o ×1,5. RTP teórico 93 %. |
| 🎡 Ruleta del Caos (casa) | 37 casillas. Rojo/Negro ×2 (18/37), Verde ×36 (1/37). |
| ⚡ Quick Draw (pozo) | El servidor mide desde la señal. Anticipar = descalificado y perdés la apuesta. |
| 🃏 Alto o Bajo (casa) | Hasta 5 aciertos, tope ×25. Misma carta = se repite sin contar. Podés plantarte. |
| 🎯 Smash Cash (pozo) | 15 s. Monedas 100, lingotes 300, bombas −150. Combo hasta ×3. El servidor valida cada golpe. |
| 💎 Cofres Malditos (casa) | 6 cofres, máx. 4 aperturas: +25 %, +50 %, +100 %, ×1,4 o TRAMPA (perdés todo). |

**Economía**
- *Juegos de pozo*: las apuestas forman un pozo que el servidor reparte según el ranking; la suma de pagos es exactamente la suma de apuestas (no se crean ni duplican monedas).
- *Juegos contra la casa*: la apuesta se descuenta al cierre y la casa paga el premio.
- Si no confirmás la apuesta a tiempo, **no participás** de esa ronda. El saldo nunca es negativo.
- Si no te alcanza para la apuesta mínima, el casino te presta una vez por partida; después mirás la ronda.
- **Gemas** (independientes de las monedas): participación 5, 3º +8, 2º +15, campeón +40 (+25 si hay empate) y logros. No se compran, no se apuestan, no valen dinero. La entrega es idempotente: reconectar o refrescar no duplica premios.
- Las **monedas del perfil** son un acumulado de carrera (empieza en 1.000, sube o baja con el resultado neto de cada partida, mínimo 0). Las apuestas usan el saldo de la partida, que se reinicia en cada una.

**Desconexiones**
- Tenés 90 s para volver (la app te devuelve a tu sala sola). Tu apuesta sigue vigente y las acciones pendientes se resuelven solas (giro o retiro automático).
- Si el anfitrión se cae, a los 15 s el mando pasa al jugador conectado más antiguo.
- Quien abandona queda al final y no cobra premios. Con menos de 2 jugadores activos la partida termina y solo se paga participación.
- Las salas vacías se eliminan a los 2 minutos.

**Limitación del modo local:** si la PC anfitriona apaga o cierra el servidor, las partidas en curso se cortan hasta que vuelva a iniciarse. Perfiles y compras no se pierden (están en `data/casino-chaos.db`).

---

## Arquitectura
```
server/   index.js · rooms.js (salas y rondas) · socket-handlers.js · economy.js · ranking.js
          security.js · database.js (SQLite) · catalog.js · minigames/*.js
public/   index.html · css/ · js/ (app, socket-client, audio, ui, profile, shop, minigames/*)
tests/    reglas, base de datos, salas, partidas completas y Smash Cash en vivo
```
- El **servidor es la autoridad**: saldos, apuestas, azar (`crypto.randomInt`), tiempos de reacción, puntajes, premios, compras y ranking. El cliente solo envía intenciones (`spin`, `press`, `hit {id}`, `open {index}`…).
- Seguridad: token aleatorio de 256 bits (se guarda su hash), un socket autenticado por jugador, validación de cada evento, límite de tamaño (20 KB) y de frecuencia, SQL parametrizado y chat solo con mensajes predefinidos.
- Tablas: `players`, `inventory`, `equipped`, `ledger` (clave única = idempotencia), `matches`, `match_players`, `achievements`.

## Pruebas
```
npm test
```
34 pruebas (≈45 s, incluye una ronda real de Smash Cash): salas, códigos inválidos, límite de 8, apuestas inválidas, conservación del pozo, premios sin duplicar, compras, los seis minijuegos, empates, desconexión y reingreso, transferencia de anfitrión, aislamiento entre salas, intentos de trampa y persistencia tras reiniciar.

## Qué NO se probó
- La interfaz se probó con un navegador simulado (jsdom): perfil, tienda, estadísticas, lobby de dos jugadores y 10 rondas con los seis minijuegos, sin errores de JavaScript. **No se probó en navegadores ni celulares reales**: aspecto visual, animaciones, sonido y vibración quedan sin verificar.
- No se probó en Windows ni en un Wi-Fi real; sí se verificó que el servidor escucha en `0.0.0.0` y responde por la IP de red.
