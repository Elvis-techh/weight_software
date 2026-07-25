const PLANILLA_DAY_NAMES = Object.freeze([
    { short: 'D', long: 'Domingo' },
    { short: 'L', long: 'Lunes' },
    { short: 'M', long: 'Martes' },
    { short: 'M', long: 'Miércoles' },
    { short: 'J', long: 'Jueves' },
    { short: 'V', long: 'Viernes' },
    { short: 'S', long: 'Sábado' }
]);

function normalizarAsistencia(record = {}) {
    return {
        fecha: String(record.fecha || ''),
        trabajado: Boolean(record.trabajado),
        horaInicio: String(record.horaInicio ?? record.hora_inicio ?? '07:00'),
        horaFin: String(record.horaFin ?? record.hora_fin ?? '16:00')
    };
}

function normalizarTrabajador(record = {}) {
    const sueldoBase = toFiniteNumber(record.sueldoBase ?? record.sueldo_base);
    const diasTrabajados = toFiniteNumber(
        record.diasTrabajados ?? record.dias_trabajados ?? record.diasPeriodo,
        0
    );
    const extras = toFiniteNumber(record.extras ?? record.extrasPeriodo, 0);

    return {
        id: record.id,
        nombre: String(record.nombre || ''),
        apellido: String(record.apellido || ''),
        telefono: String(record.telefono || ''),
        sueldoBase,
        diasTrabajados,
        extras,
        totalPeriodo: toFiniteNumber(
            record.totalPeriodo,
            (sueldoBase / 6) * diasTrabajados + extras
        ),
        asistencia: Array.isArray(record.asistencia)
            ? record.asistencia.map(normalizarAsistencia)
            : []
    };
}

function getPlanillaSelectedRange({ notify = false } = {}) {
    const start = document.getElementById('planilla-filter-start')?.value || '';
    const end = document.getElementById('planilla-filter-end')?.value || '';
    const dates = enumerateLocalDates(start, end, 32);

    let error = '';
    if (!parseLocalIsoDate(start) || !parseLocalIsoDate(end)) {
        error = 'Seleccione un rango de fechas válido.';
    } else if (start > end) {
        error = 'La fecha inicial no puede ser posterior a la fecha final.';
    } else if (dates.length > 31) {
        error = 'El período de planilla no puede superar 31 días.';
    }

    if (error) {
        if (notify) mostrarNotificacion(error, 'error');
        return null;
    }

    return { start, end, dates };
}

function setPlanillaDateRange(start, end) {
    const startInput = document.getElementById('planilla-filter-start');
    const endInput = document.getElementById('planilla-filter-end');
    if (startInput) startInput.value = start;
    if (endInput) endInput.value = end;
}

async function actualizarRangoPlanilla() {
    if (!getPlanillaSelectedRange({ notify: true })) return;
    await fetchPlanilla();
}

async function irSemanaActualPlanilla() {
    const range = getCurrentWeekRange();
    setPlanillaDateRange(range.start, range.end);
    await fetchPlanilla();
}

async function moverRangoPlanilla(days) {
    const range = getPlanillaSelectedRange({ notify: true });
    if (!range) return;

    const start = addLocalDays(range.start, days);
    const end = addLocalDays(range.end, days);
    setPlanillaDateRange(formatLocalIsoDate(start), formatLocalIsoDate(end));
    await fetchPlanilla();
}

function abrirPlanillaModal(id = null) {
    const trabajador = id == null
        ? null
        : planillaData.find(item => sameRecordId(item.id, id));

    if (id != null && !trabajador) {
        return mostrarNotificacion('Trabajador no encontrado.', 'error');
    }

    document.getElementById('planilla-modal-title').textContent = trabajador
        ? 'Editar Trabajador'
        : 'Agregar Trabajador';
    document.getElementById('planilla-edit-id').value = trabajador?.id ?? '';
    document.getElementById('planilla-nombre').value = trabajador?.nombre || '';
    document.getElementById('planilla-apellido').value = trabajador?.apellido || '';
    document.getElementById('planilla-telefono').value = trabajador?.telefono || '+504 ';
    document.getElementById('planilla-sueldo').value = trabajador
        ? formatNumberForInput(trabajador.sueldoBase, 2)
        : '';
    document.getElementById('planilla-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('planilla-nombre')?.focus(), 0);
}

function cerrarPlanillaModal() {
    document.getElementById('planilla-modal').classList.add('hidden');
}

async function guardarTrabajador() {
    const id = document.getElementById('planilla-edit-id').value;
    const telefono = document.getElementById('planilla-telefono').value.trim();
    const payload = {
        nombre: document.getElementById('planilla-nombre').value.trim(),
        apellido: document.getElementById('planilla-apellido').value.trim(),
        telefono: telefono === '+504' ? '' : telefono,
        sueldoBase: parseFormattedNumber(document.getElementById('planilla-sueldo').value)
    };

    if (!payload.nombre || !payload.apellido) {
        return mostrarNotificacion('Nombre y apellido son obligatorios.', 'error');
    }
    if (!isValidInternationalPhone(payload.telefono)) {
        return mostrarNotificacion(
            'Para Honduras use el formato +504 1234-5678. Otros países deben comenzar con + y su código de área.',
            'error'
        );
    }
    if (!Number.isFinite(payload.sueldoBase) || payload.sueldoBase <= 0) {
        return mostrarNotificacion('El sueldo base debe ser mayor que cero.', 'error');
    }

    const saveButton = document.getElementById('planilla-save-button');
    try {
        if (saveButton) {
            saveButton.disabled = true;
            saveButton.textContent = 'Guardando...';
        }

        await (id
            ? apiRequest(`/api/planilla/${encodeURIComponent(id)}`, {
                method: 'PUT',
                body: payload
            })
            : apiRequest('/api/planilla', {
                method: 'POST',
                body: payload
            }));

        cerrarPlanillaModal();
        await fetchPlanilla();
        mostrarNotificacion(id ? 'Trabajador actualizado.' : 'Trabajador registrado.');
    } catch (error) {
        console.error('Error al guardar trabajador:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar el trabajador.', 'error');
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = 'Guardar';
        }
    }
}

function getAttendanceForDate(trabajador, fecha) {
    return trabajador.asistencia.find(item => item.fecha === fecha) || null;
}

function getDayMetadata(fecha) {
    const date = parseLocalIsoDate(fecha);
    if (!date) return { short: '?', long: 'Fecha inválida', dayNumber: '' };
    const names = PLANILLA_DAY_NAMES[date.getDay()];
    return {
        ...names,
        dayNumber: String(date.getDate()).padStart(2, '0'),
        isSunday: date.getDay() === 0
    };
}

function renderAttendanceButton(trabajador, fecha) {
    const attendance = getAttendanceForDate(trabajador, fecha);
    const day = getDayMetadata(fecha);
    const worked = Boolean(attendance?.trabajado);
    const explicitlyOff = attendance && !attendance.trabajado;

    let classes = 'border-gray-300 bg-white text-gray-600 hover:border-orange-400 hover:bg-orange-50';
    if (worked) {
        classes = 'border-emerald-500 bg-emerald-100 text-emerald-800 hover:bg-emerald-200';
    } else if (day.isSunday || explicitlyOff) {
        classes = 'border-red-200 bg-red-50 text-red-500 hover:border-red-400 hover:bg-red-100';
    }

    const status = worked
        ? `${attendance.horaInicio}–${attendance.horaFin}`
        : day.isSunday
            ? 'No laborable por defecto'
            : 'Sin registrar';

    return `
        <button type="button"
            onclick="abrirJornadaModal('${escapeHtml(trabajador.id)}', '${fecha}')"
            title="${escapeHtml(`${day.long} ${formatDateForDisplay(fecha)} · ${status}`)}"
            class="w-9 h-11 rounded-lg border font-black leading-none flex flex-col items-center justify-center transition-colors ${classes}">
            <span class="text-[11px]">${day.short}</span>
            <span class="text-[9px] font-mono mt-1">${day.dayNumber}</span>
        </button>
    `;
}

function calcularTotalTrabajadorPlanilla(trabajador) {
    return (toFiniteNumber(trabajador.sueldoBase) / 6) * toFiniteNumber(trabajador.diasTrabajados)
        + toFiniteNumber(trabajador.extras);
}

function actualizarTotalesPlanilla() {
    const totalWorkers = planillaData.length;
    const totalDays = planillaData.reduce(
        (sum, worker) => sum + toFiniteNumber(worker.diasTrabajados),
        0
    );
    const totalPayroll = planillaData.reduce(
        (sum, worker) => sum + calcularTotalTrabajadorPlanilla(worker),
        0
    );

    const workersDisplay = document.getElementById('planilla-total-trabajadores');
    const daysDisplay = document.getElementById('planilla-total-dias');
    const payrollDisplay = document.getElementById('planilla-total-pagar');
    if (workersDisplay) workersDisplay.textContent = totalWorkers.toLocaleString('en-US');
    if (daysDisplay) daysDisplay.textContent = totalDays.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (payrollDisplay) payrollDisplay.textContent = `L ${formatMoney(totalPayroll)}`;
}

function recalcularFilaPlanilla(id) {
    const trabajador = planillaData.find(item => sameRecordId(item.id, id));
    if (!trabajador) return;

    const extrasInput = document.getElementById(`extras-${id}`);
    const extras = parseFormattedNumber(extrasInput?.value);
    trabajador.extras = Number.isFinite(extras) ? Math.max(extras, 0) : 0;
    trabajador.totalPeriodo = calcularTotalTrabajadorPlanilla(trabajador);

    const display = document.getElementById(`total-${id}`);
    if (display) display.textContent = `L ${formatMoney(trabajador.totalPeriodo)}`;
    actualizarTotalesPlanilla();
}

async function guardarExtrasPeriodo(id) {
    const trabajador = planillaData.find(item => sameRecordId(item.id, id));
    const range = getPlanillaSelectedRange({ notify: true });
    if (!trabajador || !range) return;

    recalcularFilaPlanilla(id);

    try {
        const result = await apiRequest(`/api/planilla/${encodeURIComponent(id)}/periodo`, {
            method: 'PUT',
            body: {
                inicio: range.start,
                fin: range.end,
                extras: trabajador.extras
            }
        });
        const saved = normalizarTrabajador(result?.trabajador || result);
        Object.assign(trabajador, saved);
        renderPlanilla();
    } catch (error) {
        console.error('No se pudieron guardar los extras:', error);
        mostrarNotificacion(error.message || 'No se pudieron guardar los extras.', 'error');
        await fetchPlanilla().catch(() => { });
    }
}

function renderPlanilla() {
    const tbody = document.getElementById('planilla-table-body');
    if (!tbody) return;

    const range = getPlanillaSelectedRange();
    const dates = range?.dates || [];
    const periodLabel = document.getElementById('planilla-period-label');
    if (periodLabel && range) {
        periodLabel.textContent = `${formatDateForDisplay(range.start)} – ${formatDateForDisplay(range.end)}`;
    }

    if (planillaData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-10 text-center text-gray-400">Sin trabajadores registrados.</td></tr>';
        actualizarTotalesPlanilla();
        return;
    }

    tbody.innerHTML = planillaData.map(trabajador => {
        const id = escapeHtml(trabajador.id);
        const total = calcularTotalTrabajadorPlanilla(trabajador);
        const attendanceButtons = dates.map(fecha => renderAttendanceButton(trabajador, fecha)).join('');

        return `
            <tr class="hover:bg-orange-50/60 border-b border-gray-100 align-middle">
                <td class="p-3 min-w-[190px]">
                    <div class="font-bold text-gray-800">${escapeHtml(`${trabajador.nombre} ${trabajador.apellido}`)}</div>
                    <div class="text-xs text-gray-500">${escapeHtml(trabajador.telefono || 'Sin teléfono')}</div>
                </td>
                <td class="p-3 text-right min-w-[125px]">
                    <span class="font-mono font-bold text-gray-700 whitespace-nowrap">L ${formatMoney(trabajador.sueldoBase)}</span>
                </td>
                <td class="p-3 min-w-[285px]">
                    <div class="flex gap-1.5 flex-wrap">${attendanceButtons}</div>
                </td>
                <td class="p-3 text-center min-w-[90px]">
                    <span class="inline-flex min-w-12 justify-center rounded-lg bg-orange-100 px-3 py-2 font-mono font-black text-orange-800">
                        ${toFiniteNumber(trabajador.diasTrabajados).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </span>
                </td>
                <td class="p-3 text-center min-w-[130px]">
                    <input type="text" inputmode="numeric" id="extras-${id}"
                        value="${formatNumberForInput(trabajador.extras, 0)}"
                        oninput="formatCurrencyInput(event); recalcularFilaPlanilla('${id}')"
                        onchange="guardarExtrasPeriodo('${id}')"
                        class="w-28 border rounded-lg p-2 text-right font-bold text-green-700 focus:ring-2 focus:ring-orange-300 outline-none">
                </td>
                <td class="p-3 text-right bg-orange-50 min-w-[150px]">
                    <div id="total-${id}" class="font-mono font-black text-orange-700 text-lg whitespace-nowrap">L ${formatMoney(total)}</div>
                </td>
                <td class="p-3 text-center min-w-[90px]">
                    <button type="button" onclick="abrirPlanillaModal('${id}')" class="text-blue-500 hover:text-blue-800 mx-1" title="Editar trabajador"><span class="material-icons text-[18px]">edit</span></button>
                    <button type="button" onclick="abrirActionModal('delete_trabajador', '${id}')" class="text-red-400 hover:text-red-700 mx-1" title="Eliminar trabajador"><span class="material-icons text-[18px]">delete</span></button>
                </td>
            </tr>
        `;
    }).join('');

    actualizarTotalesPlanilla();
}

function toggleJornadaTimeInputs() {
    const worked = document.getElementById('planilla-day-worked')?.checked;
    ['planilla-day-start-time', 'planilla-day-end-time'].forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;
        input.disabled = !worked;
        input.classList.toggle('opacity-50', !worked);
    });
    actualizarDuracionJornada();
}

function actualizarDuracionJornada() {
    const worked = document.getElementById('planilla-day-worked')?.checked;
    const display = document.getElementById('planilla-day-duration');
    if (!display) return;

    if (!worked) {
        display.textContent = 'Día no trabajado';
        return;
    }

    const start = document.getElementById('planilla-day-start-time')?.value || '';
    const end = document.getElementById('planilla-day-end-time')?.value || '';
    const toMinutes = value => {
        const [hours, minutes] = value.split(':').map(Number);
        return hours * 60 + minutes;
    };

    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || toMinutes(end) <= toMinutes(start)) {
        display.textContent = 'Revise las horas seleccionadas';
        return;
    }

    const duration = toMinutes(end) - toMinutes(start);
    const hours = Math.floor(duration / 60);
    const minutes = duration % 60;
    display.textContent = `${hours} h${minutes ? ` ${minutes} min` : ''}`;
}

function abrirJornadaModal(workerId, fecha) {
    const trabajador = planillaData.find(item => sameRecordId(item.id, workerId));
    const date = parseLocalIsoDate(fecha);
    if (!trabajador || !date) return mostrarNotificacion('No se encontró la jornada seleccionada.', 'error');

    const attendance = getAttendanceForDate(trabajador, fecha);
    const day = getDayMetadata(fecha);
    const defaultWorked = attendance ? attendance.trabajado : !day.isSunday;

    document.getElementById('planilla-day-worker-id').value = trabajador.id;
    document.getElementById('planilla-day-date').value = fecha;
    document.getElementById('planilla-day-worker-name').textContent = `${trabajador.nombre} ${trabajador.apellido}`;
    document.getElementById('planilla-day-date-label').textContent = `${day.long}, ${formatDateForDisplay(fecha)}`;
    document.getElementById('planilla-day-worked').checked = defaultWorked;
    document.getElementById('planilla-day-start-time').value = attendance?.horaInicio || '07:00';
    document.getElementById('planilla-day-end-time').value = attendance?.horaFin || '16:00';
    document.getElementById('planilla-day-modal').classList.remove('hidden');
    toggleJornadaTimeInputs();
}

function cerrarJornadaModal() {
    document.getElementById('planilla-day-modal').classList.add('hidden');
}

async function guardarJornadaPlanilla() {
    const workerId = document.getElementById('planilla-day-worker-id').value;
    const fecha = document.getElementById('planilla-day-date').value;
    const trabajado = document.getElementById('planilla-day-worked').checked;
    const horaInicio = document.getElementById('planilla-day-start-time').value;
    const horaFin = document.getElementById('planilla-day-end-time').value;

    if (trabajado && (!horaInicio || !horaFin || horaFin <= horaInicio)) {
        return mostrarNotificacion('La hora de salida debe ser posterior a la hora de entrada.', 'error');
    }

    const saveButton = document.getElementById('planilla-day-save-button');
    try {
        if (saveButton) {
            saveButton.disabled = true;
            saveButton.textContent = 'Guardando...';
        }

        await apiRequest(
            `/api/planilla/${encodeURIComponent(workerId)}/asistencia/${encodeURIComponent(fecha)}`,
            {
                method: 'PUT',
                body: { trabajado, horaInicio, horaFin }
            }
        );

        cerrarJornadaModal();
        await fetchPlanilla();
        mostrarNotificacion(trabajado ? 'Jornada guardada.' : 'Día marcado como no trabajado.');
    } catch (error) {
        console.error('No se pudo guardar la jornada:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar la jornada.', 'error');
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = 'Guardar Jornada';
        }
    }
}

async function eliminarTrabajadorServidor(id, justificacion) {
    await apiRequest(`/api/planilla/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { justificacion }
    });
    planillaData = planillaData.filter(item => !sameRecordId(item.id, id));
    renderPlanilla();
}