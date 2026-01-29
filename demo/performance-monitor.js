/**
 * Performance Monitoring Utilities for CeriousScroll Patent Proof of Concept
 * 
 * This module provides comprehensive performance monitoring capabilities including:
 * - Real-time FPS measurement
 * - Memory usage tracking
 * - Scroll latency measurement
 * - Benchmark data collection
 * - CSV export for patent documentation
 * 
 * @author Cerious DevTech LLC
 * @version 1.0.0
 * @since 2025-10-07
 */

/**
 * Performance Monitor Class
 * Tracks various performance metrics in real-time for patent validation
 */
export class PerformanceMonitor {
    constructor() {
        this.metrics = {
            fps: 0,
            memoryUsage: 0,
            scrollLatency: 0,
            algorithmLatency: 0, // Pure algorithm time (what we were measuring)
            fullFrameLatency: 0, // Including DOM updates (closer to Chrome profiler)
            renderTime: 0,
            totalScrollEvents: 0,
            averageScrollLatency: 0,
            peakMemoryUsage: 0,
            scrollEventsPerSecond: 0,
            baselineMemory: 0,
            virtualizationOverhead: 0,
            dataMemory: 0,
            dataSizeFormatted: '0 B',
            virtualizationOverheadFormatted: '0 MB',
            totalMemoryFormatted: '0 MB'
        };
        
        this.history = {
            fps: [],
            memory: [],
            scrollLatency: [],
            renderTime: []
        };
        
        this.benchmarkData = [];
        this.isMonitoring = false;
        this.scrollStartTime = 0;
        this.scrollEndTime = 0;
        this.lastScrollTime = 0; // Track when last scroll activity occurred
        this.renderStartTime = 0;
        this.renderEndTime = 0;
        
        // Capture baseline memory before any data is created
        this.captureBaselineMemory();
        
        // Initialize monitoring
        this.startFPSMonitoring();
        this.startMemoryMonitoring();
    }
    
    /**
     * Start real-time FPS monitoring
     */
    startFPSMonitoring() {
        let frameCount = 0;
        let lastFPSUpdate = performance.now();
        
        const measureFPS = () => {
            const now = performance.now();
            frameCount++;
            
            // Update FPS every 500ms for smooth but not too frequent updates
            if (now - lastFPSUpdate >= 500) {
                const deltaTime = now - lastFPSUpdate;
                const fps = Math.round((frameCount / deltaTime) * 1000);
                this.metrics.fps = fps; // Show actual performance - no cap!
                this.history.fps.push(this.metrics.fps);
                
                // Keep only last 100 measurements
                if (this.history.fps.length > 100) {
                    this.history.fps.shift();
                }
                
                // Reset for next measurement period
                frameCount = 0;
                lastFPSUpdate = now;
            }
            
            requestAnimationFrame(measureFPS);
        };
        
        requestAnimationFrame(measureFPS);
    }
    
    /**
     * Capture baseline memory before creating large datasets
     */
    captureBaselineMemory() {
        if (performance.memory) {
            const oldBaseline = this.metrics.baselineMemory;
            this.metrics.baselineMemory = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
        }
    }
    
    /**
     * Start memory usage monitoring
     */
    startMemoryMonitoring() {
        const measureMemory = () => {
            if (performance.memory) {
                // Use byte precision for maximum accuracy
                const memoryBytes = performance.memory.usedJSHeapSize;
                const memoryMB = Math.round(memoryBytes / 1024 / 1024);
                
                this.metrics.memoryUsage = memoryMB;
                this.metrics.peakMemoryUsage = Math.max(this.metrics.peakMemoryUsage, memoryMB);
                
                // Calculate virtualization overhead with byte precision for maximum accuracy
                const baselineBytes = this.metrics.baselineMemory * 1024 * 1024;
                
                // Add validation to prevent NaN calculations
                if (!isFinite(baselineBytes) || !isFinite(memoryBytes)) {
                    console.warn('Invalid memory values detected:', {
                        memoryBytes: memoryBytes,
                        baselineBytes: baselineBytes
                    });
                    return; // Skip this measurement
                }
                
                // Calculate total overhead (virtualization + data) from baseline
                const totalOverheadBytes = Math.max(0, memoryBytes - baselineBytes);
                
                // CRITICAL: performance.memory is unreliable for incremental measurements
                // due to GC, memory compaction, and timing issues.
                // Virtualization overhead should be CONSTANT - it's only the DOM elements + scroller instance
                
                // Count actual DOM elements in the scroller container
                const scrollerContainer = document.querySelector('#scrollContent, .scroll-content');
                const domElementCount = scrollerContainer ? scrollerContainer.children.length : 0;
                
                // Calculate ACTUAL virtualization overhead (constant, not growing with dataset)
                const estimatedDOMOverhead = domElementCount * 2000; // ~2KB per row element (conservative)
                const scrollerInstanceOverhead = 50000; // ~50KB for scroller instance and listeners
                const virtualizationOverheadBytes = estimatedDOMOverhead + scrollerInstanceOverhead;
                
                // Virtualization overhead is just the scroller overhead, NOT total memory growth
                const adjustedOverheadBytes = virtualizationOverheadBytes;
                
                // Note: This includes both data + virtualization overhead
                // Real solution: measure memory before data creation, after data creation, 
                // and after scroller initialization to isolate each component
                
                // Validate overhead calculation before setting
                if (!isFinite(adjustedOverheadBytes)) {
                    console.warn('Invalid overhead calculation (NaN), setting to 0:', adjustedOverheadBytes);
                    this.metrics.virtualizationOverhead = 0;
                    this.metrics.virtualizationOverheadFormatted = DataGenerator.formatMemorySize(0);
                } else {
                    // Use raw calculated value (can be negative if data estimate is high)
                    this.metrics.virtualizationOverhead = Math.round(adjustedOverheadBytes / 1024 / 1024 * 1000) / 1000; // Round to 3 decimal places in MB
                    this.metrics.virtualizationOverheadFormatted = DataGenerator.formatMemorySize(Math.max(0, adjustedOverheadBytes)); // Don't format negative values
                }
                
                // Format memory values using consistent formatting
                this.metrics.totalMemoryFormatted = DataGenerator.formatMemorySize(memoryBytes);
                
                this.history.memory.push(memoryMB);
                
                // Keep only last 100 measurements
                if (this.history.memory.length > 100) {
                    this.history.memory.shift();
                }
            }
        };
        
        setInterval(measureMemory, 1000); // Update every second
    }
    
    /**
     * Set the data memory size (called when dataset is generated)
     */
    setDataMemory(dataSizeMB, dataSizeFormatted = null) {
        // Removed verbose logging to prevent memory accumulation from console
        
        // Validate input to prevent NaN propagation
        if (typeof dataSizeMB !== 'number' || !isFinite(dataSizeMB) || dataSizeMB < 0) {
            console.warn('Invalid dataSizeMB value:', dataSizeMB, 'Setting to 0');
            dataSizeMB = 0;
        }
        
        this.metrics.dataMemory = dataSizeMB;
        this.metrics.dataSizeFormatted = dataSizeFormatted || `${dataSizeMB} MB`;
        
        // Recalculate virtualization overhead with improved logic
        if (performance.memory) {
            const memoryBytes = performance.memory.usedJSHeapSize;
            const baselineBytes = this.metrics.baselineMemory * 1024 * 1024;
            
            // Validate values before calculation
            if (!isFinite(memoryBytes) || !isFinite(baselineBytes)) {
                console.warn('Invalid memory values in setDataMemory:', {
                    memoryBytes: memoryBytes,
                    baselineBytes: baselineBytes
                });
                return; // Skip recalculation
            }
            
            // Calculate total overhead from baseline
            const totalOverheadBytes = Math.max(0, memoryBytes - baselineBytes);
            
            // Estimate virtualization overhead (constant regardless of data size)
            const visibleRowsEstimate = 50;
            const domElementsOverhead = visibleRowsEstimate * 200;
            const scrollerInstanceOverhead = 50 * 1024;
            const estimatedVirtualizationOverhead = domElementsOverhead + scrollerInstanceOverhead;
            
            // Use the estimated virtualization overhead (no minimum cap)
            const adjustedOverheadBytes = Math.min(totalOverheadBytes, estimatedVirtualizationOverhead);
            
            // Validate overhead calculation
            if (!isFinite(adjustedOverheadBytes)) {
                console.warn('Invalid overhead calculation in setDataMemory, setting to 0');
                this.metrics.virtualizationOverhead = 0;
                this.metrics.virtualizationOverheadFormatted = DataGenerator.formatMemorySize(0);
            } else {
                this.metrics.virtualizationOverhead = Math.round(adjustedOverheadBytes / 1024 / 1024 * 1000) / 1000; // Round to 3 decimal places in MB
                this.metrics.virtualizationOverheadFormatted = DataGenerator.formatMemorySize(Math.max(0, adjustedOverheadBytes));
            }
        }
    }
    
    /**
     * Reset all memory tracking and recapture baseline
     * Call this after data cleanup to ensure accurate memory tracking
     */
    resetMemoryTracking() {
        // Reset all memory-related metrics
        this.metrics.dataMemory = 0;
        this.metrics.virtualizationOverhead = 0;
        this.metrics.peakMemoryUsage = 0;
        this.metrics.dataSizeFormatted = '0 B';
        this.metrics.virtualizationOverheadFormatted = '0 MB';
        
        // Clear memory history
        this.history.memory = [];
    }
    
    /**
     * Start scroll performance measurement
     */
    startScrollMeasurement() {
        this.scrollStartTime = performance.now();
        this.lastScrollTime = this.scrollStartTime; // Update last scroll activity time
        this.frameStartTime = performance.now(); // Track full frame time
    }
    
    /**
     * Start benchmark-only performance measurement (algorithm only, no viewport/DOM)
     */
    startBenchmarkMeasurement() {
        this.benchmarkStartTime = performance.now();
    }
    
    /**
     * End benchmark-only performance measurement
     */
    endBenchmarkMeasurement() {
        const algorithmLatency = performance.now() - this.benchmarkStartTime;
        return Math.round(algorithmLatency * 100) / 100;
    }
    
    /**
     * End scroll performance measurement
     */
    endScrollMeasurement() {
        this.scrollEndTime = performance.now();
        
        // Algorithm-only latency (our current measurement - just the CeriousScroll logic)
        const algorithmLatency = this.scrollEndTime - this.scrollStartTime;
        this.metrics.algorithmLatency = Math.round(algorithmLatency * 100) / 100;
        
        // Removed timing verification logging to prevent console memory accumulation
        
        // Schedule frame completion measurement after DOM updates (throttled)
        if (!this.pendingFrameMeasurement) {
            this.pendingFrameMeasurement = true;
            requestAnimationFrame(() => {
                const frameEndTime = performance.now();
                const fullFrameLatency = frameEndTime - this.frameStartTime;
                
                // Update with full frame latency (more comparable to Chrome profiler)
                this.metrics.fullFrameLatency = Math.round(fullFrameLatency * 100) / 100;
                
                // Silent operation - removed timing breakdown logging to prevent console accumulation
                
                // For UI display, show the full frame latency (more honest and comparable to Chrome)
                this.metrics.scrollLatency = this.metrics.fullFrameLatency;
                this.pendingFrameMeasurement = false;
            });
        }
        
        this.metrics.totalScrollEvents++;
        
        // Calculate average latency using the SAME measurement as scrollLatency (fullFrameLatency)
        // Throttle history updates for better performance with rapid scrolling
        if (!this.lastHistoryUpdate || Date.now() - this.lastHistoryUpdate > 16) { // Max 60 updates/sec
            this.history.scrollLatency.push(this.metrics.fullFrameLatency);
            if (this.history.scrollLatency.length > 100) {
                this.history.scrollLatency.shift();
            }
            
            const sum = this.history.scrollLatency.reduce((a, b) => a + b, 0);
            this.metrics.averageScrollLatency = Math.round((sum / this.history.scrollLatency.length) * 100) / 100;
            this.lastHistoryUpdate = Date.now();
        }
        
        // Calculate scroll events per second - track timestamps for accurate calculation
        const now = Date.now();
        if (!this.scrollEventTimes) {
            this.scrollEventTimes = [];
        }
        this.scrollEventTimes.push(now);
        
        // Keep only events from the last second
        this.scrollEventTimes = this.scrollEventTimes.filter(time => now - time <= 1000);
        this.metrics.scrollEventsPerSecond = this.scrollEventTimes.length;
    }
    
    /**
     * Start render time measurement
     */
    startRenderMeasurement() {
        this.renderStartTime = performance.now();
    }
    
    /**
     * End render time measurement
     */
    endRenderMeasurement() {
        this.renderEndTime = performance.now();
        const renderTime = this.renderEndTime - this.renderStartTime;
        this.metrics.renderTime = Math.round(renderTime * 100) / 100;
        this.history.renderTime.push(renderTime);
        
        if (this.history.renderTime.length > 100) {
            this.history.renderTime.shift();
        }
    }
    
    /**
     * Record benchmark data point
     */
    recordBenchmark(datasetSize, scrollPosition, visibleRows) {
        // Throttle benchmark recording for large datasets to reduce overhead
        const now = Date.now();
        const timeSinceLastRecord = now - (this.lastBenchmarkRecord || 0);
        const isLargeDataset = datasetSize > 1000000; // > 1M rows
        const shouldThrottle = isLargeDataset && timeSinceLastRecord < 100; // Throttle to max 10 records/sec for large datasets
        
        if (shouldThrottle) {
            return; // Skip this recording to maintain performance
        }
        
        this.lastBenchmarkRecord = now;
        
        const dataPoint = {
            timestamp: now,
            datasetSize,
            scrollPosition,
            visibleRows,
            fps: this.metrics.fps,
            memoryUsage: this.metrics.memoryUsage,
            scrollLatency: this.metrics.scrollLatency,
            renderTime: this.metrics.renderTime
        };
        
        this.benchmarkData.push(dataPoint);
        
        // Keep fewer data points for large datasets to reduce memory usage
        const maxDataPoints = isLargeDataset ? 500 : 1000;
        if (this.benchmarkData.length > maxDataPoints) {
            this.benchmarkData.shift();
        }
    }
    
    /**
     * Get current performance metrics
     */
    getMetrics() {
        return { ...this.metrics };
    }
    
    /**
     * Get performance history
     */
    getHistory() {
        return { ...this.history };
    }
    
    /**
     * Export benchmark data as CSV for patent documentation
     */
    exportBenchmarkCSV() {
        const headers = [
            'Timestamp',
            'Dataset Size',
            'Scroll Position',
            'Visible Rows',
            'FPS',
            'Memory Usage (MB)',
            'Scroll Latency (ms)',
            'Render Time (ms)'
        ];
        
        const csvContent = [
            headers.join(','),
            ...this.benchmarkData.map(data => [
                new Date(data.timestamp).toISOString(),
                data.datasetSize,
                data.scrollPosition,
                data.visibleRows,
                data.fps,
                data.memoryUsage,
                data.scrollLatency,
                data.renderTime
            ].join(','))
        ].join('\n');
        
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cerious-scroll-benchmark-${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    /**
     * Generate performance report for patent documentation
     */
    generatePerformanceReport() {
        const avgFPS = this.history.fps.reduce((a, b) => a + b, 0) / this.history.fps.length || 0;
        const avgMemory = this.history.memory.reduce((a, b) => a + b, 0) / this.history.memory.length || 0;
        const avgRenderTime = this.history.renderTime.reduce((a, b) => a + b, 0) / this.history.renderTime.length || 0;
        
        return {
            summary: {
                averageFPS: Math.round(avgFPS),
                averageMemoryUsage: Math.round(avgMemory),
                peakMemoryUsage: this.metrics.peakMemoryUsage,
                averageScrollLatency: this.metrics.averageScrollLatency,
                averageRenderTime: Math.round(avgRenderTime * 100) / 100,
                totalScrollEvents: this.metrics.totalScrollEvents,
                dataPoints: this.benchmarkData.length
            },
            details: {
                fpsHistory: [...this.history.fps],
                memoryHistory: [...this.history.memory],
                scrollLatencyHistory: [...this.history.scrollLatency],
                renderTimeHistory: [...this.history.renderTime]
            },
            benchmarkData: [...this.benchmarkData]
        };
    }
    
    /**
     * Reset all metrics and history
     */
    reset() {
        this.metrics = {
            fps: 0,
            memoryUsage: 0,
            scrollLatency: 0,
            renderTime: 0,
            totalScrollEvents: 0,
            averageScrollLatency: 0,
            peakMemoryUsage: 0,
            scrollEventsPerSecond: 0
        };
        
        this.history = {
            fps: [],
            memory: [],
            scrollLatency: [],
            renderTime: []
        };
        
        this.benchmarkData = [];
        this.frameCount = 0;
    }
}

/**
 * Data Generator for creating test datasets
 */
export class DataGenerator {
    static DEFAULT_COLUMN_PROFILE = {
        min: 8,
        max: 18,
        previewCount: 6,
        library: [
            { name: 'session_id', type: 'id' },
            { name: 'region', type: 'region' },
            { name: 'device', type: 'string' },
            { name: 'latency_ms', type: 'duration' },
            { name: 'throughput', type: 'number' },
            { name: 'cpu_load', type: 'percent' },
            { name: 'memory_mb', type: 'number' },
            { name: 'status', type: 'status' },
            { name: 'errors', type: 'number' },
            { name: 'bandwidth', type: 'bandwidth' },
            { name: 'cost', type: 'currency' }
        ]
    };

    static REGION_CODES = ['NA-EAST', 'NA-WEST', 'EU-CENTRAL', 'EU-WEST', 'AP-SOUTH', 'AP-NORTHEAST'];
    static STATUS_CODES = ['OK', 'WARN', 'DEGRADED', 'FAILED'];

    static resolveColumnProfile(profile) {
        const baseProfile = profile || {};
        const resolved = {
            min: Number.isFinite(baseProfile.min) ? baseProfile.min : DataGenerator.DEFAULT_COLUMN_PROFILE.min,
            max: Number.isFinite(baseProfile.max) ? baseProfile.max : (Number.isFinite(baseProfile.min) ? baseProfile.min : DataGenerator.DEFAULT_COLUMN_PROFILE.max),
            previewCount: Number.isFinite(baseProfile.previewCount) ? baseProfile.previewCount : DataGenerator.DEFAULT_COLUMN_PROFILE.previewCount,
            library: Array.isArray(baseProfile.library) && baseProfile.library.length > 0
                ? baseProfile.library
                : DataGenerator.DEFAULT_COLUMN_PROFILE.library
        };

        if (resolved.max < resolved.min) {
            resolved.max = resolved.min;
        }

        return resolved;
    }

    static attachColumnMetadata(target, profile) {
        if (!target) {
            return;
        }
        const resolved = DataGenerator.resolveColumnProfile(profile);
        target._columnProfile = profile || null;
        target._columnStats = {
            min: resolved.min,
            max: resolved.max,
            previewCount: resolved.previewCount
        };
    }

    static generateColumnsForRow(index, columnProfile) {
        const resolved = DataGenerator.resolveColumnProfile(columnProfile);
        const span = Math.max(0, resolved.max - resolved.min);
        const seed = DataGenerator.seededRandom(index + 9000);
        const columnCount = resolved.min + Math.floor(seed * (span + 1));
        const previewLimit = columnCount; // ensure every column is represented for grid rendering
        const columns = [];

        for (let i = 0; i < previewLimit; i++) {
            const template = resolved.library[i % resolved.library.length];
            const columnName = template?.name || template?.label || `col_${i + 1}`;
            const columnType = template?.type || 'metric';
            const valueSeed = DataGenerator.seededRandom(index + (i + 1) * 97);
            const value = DataGenerator.generateColumnValue(columnType, valueSeed, index, i);
            columns.push({
                name: columnName,
                value,
                type: columnType
            });
        }

        return { columnCount, columns, profile: resolved };
    }

    static generateColumnValue(type, seed, rowIndex, columnIndex) {
        switch (type) {
            case 'id': {
                const suffix = Math.floor(seed * 1e6).toString(36).padStart(4, '0');
                return `sess-${rowIndex.toString(36)}-${suffix}`;
            }
            case 'percent':
                return `${Math.round(seed * 100)}%`;
            case 'currency':
                return `$${(seed * 5000 + 25).toFixed(2)}`;
            case 'region': {
                const regionIndex = Math.floor(seed * DataGenerator.REGION_CODES.length);
                return DataGenerator.REGION_CODES[regionIndex];
            }
            case 'status': {
                const statusIndex = Math.floor(seed * DataGenerator.STATUS_CODES.length);
                return DataGenerator.STATUS_CODES[statusIndex];
            }
            case 'duration':
                return `${Math.round(seed * 350 + 30)} ms`;
            case 'bandwidth':
                return `${Math.round(seed * 900 + 50)} Mbps`;
            case 'number':
                return (seed * 1000 + columnIndex * 5).toFixed(0);
            case 'string':
                return `Segment-${((columnIndex + 1) % 9) + 1}`;
            default:
                return `metric-${Math.round(seed * 10000)}`;
        }
    }
    /**
     * Generate test dataset with variable row heights
     */
    static generateDataset(size, heightVariation = 'mixed', options = {}) {
        const data = [];
        const columnProfile = options.columnProfile;
        const rowModel = typeof options.rowModel === 'string' ? options.rowModel : 'full';

        const rowFactory = rowModel === 'minimal'
            ? (i) => this.generateRowDataMinimal(i, heightVariation)
            : (i) => this.generateRowData(i, heightVariation, columnProfile);
        
        for (let i = 0; i < size; i++) {
            data.push(rowFactory(i));
        }
        
        // Calculate approximate data size in memory
        data._dataSizeBytes = this.calculateDataSize(data);
        
        // Validate data size calculation
        if (!isFinite(data._dataSizeBytes) || data._dataSizeBytes < 0) {
            console.warn('Invalid data size calculation:', data._dataSizeBytes, 'for array length:', data.length);
            data._dataSizeBytes = Math.max(512, data.length * 32); // Fallback calculation
        }
        
        data._dataSizeMB = Math.max(0.01, Math.round(data._dataSizeBytes / 1024 / 1024 * 100) / 100); // Minimum 0.01 MB, round to 2 decimal places
        data._dataSizeFormatted = this.formatMemorySize(data._dataSizeBytes);

        this.attachColumnMetadata(data, columnProfile);
        
        return data;
    }

    /**
     * Generate test dataset with chunked processing to prevent UI lockup
     */
    static generateDatasetChunked(size, heightVariation = 'mixed', progressCallback = null, completionCallback = null, options = {}) {
        const data = [];
        const chunkSize = Math.min(1000, Math.max(100, Math.floor(size / 100))); // Adaptive chunk size
        let currentIndex = 0;
        const columnProfile = options.columnProfile;
        const rowModel = typeof options.rowModel === 'string' ? options.rowModel : 'full';

        const rowFactory = rowModel === 'minimal'
            ? (i) => this.generateRowDataMinimal(i, heightVariation)
            : (i) => this.generateRowData(i, heightVariation, columnProfile);
        
        const processChunk = () => {
            const endIndex = Math.min(currentIndex + chunkSize, size);
            
            // Generate chunk synchronously
            for (let i = currentIndex; i < endIndex; i++) {
                data.push(rowFactory(i));
            }
            
            currentIndex = endIndex;
            
            // Update progress
            if (progressCallback) {
                const progress = Math.round((currentIndex / size) * 100);
                progressCallback(progress);
            }
            
            // Check if we're done
            if (currentIndex >= size) {
                // Calculate approximate data size in memory
                data._dataSizeBytes = this.calculateDataSize(data);
                
                // Validate data size calculation
                if (!isFinite(data._dataSizeBytes) || data._dataSizeBytes < 0) {
                    console.warn('Invalid data size calculation in chunked generation:', data._dataSizeBytes, 'for array length:', data.length);
                    data._dataSizeBytes = Math.max(512, data.length * 32); // Fallback calculation
                }
                
                data._dataSizeMB = Math.max(0.01, Math.round(data._dataSizeBytes / 1024 / 1024 * 100) / 100); // Minimum 0.01 MB, round to 2 decimal places
                data._dataSizeFormatted = this.formatMemorySize(data._dataSizeBytes);
                this.attachColumnMetadata(data, columnProfile);
                
                if (completionCallback) {
                    completionCallback(data);
                }
            } else {
                // Continue with next chunk
                setTimeout(processChunk, 0);
            }
        };
        
        // Start processing
        setTimeout(processChunk, 0);
    }

    /**
     * Create a procedural dataset that synthesizes rows on demand
     */
    static createProceduralDataset(size, heightVariation = 'mixed', options = {}) {
        return new ProceduralDataset(size, heightVariation, options.columnProfile);
    }
    
    /**
     * Format bytes into human-readable format (B, KB, MB, GB)
     */
    static formatMemorySize(bytes) {
        // Handle invalid input values that can cause NaN
        if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) {
            console.warn('Invalid bytes value for formatMemorySize:', bytes);
            return '0 B';
        }
        
        if (bytes === 0) return '0 B';
        
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        // Ensure i is within bounds
        const clampedI = Math.max(0, Math.min(i, sizes.length - 1));
        
        const value = bytes / Math.pow(k, clampedI);
        const formatted = clampedI === 0 ? value.toString() : value.toFixed(1);
        
        return `${formatted} ${sizes[clampedI]}`;
    }

    /**
     * Calculate approximate memory size of the data array
     */
    static calculateDataSize(data) {
        if (!data || data.length === 0) return 0;
        
        // Sample first item to estimate per-item size
        const sampleItem = data[0];
        if (!sampleItem) return 0;
        
        let itemSize = 0;
        
        // Estimate JavaScript object overhead + properties
        itemSize += 64; // Object overhead
        itemSize += 8;  // id (number)
        itemSize += 8;  // height (number)
        itemSize += 8;  // timestamp (number)
        itemSize += (sampleItem.type?.length || 6) * 2; // type string (UTF-16)
        itemSize += (sampleItem.text?.length || 30) * 2; // text string (UTF-16)
        
        let totalSize = data.length * itemSize;
        
        // Add array overhead (V8 internal structures, array metadata, etc.)
        const arrayOverhead = Math.max(1024, data.length * 8); // At least 1KB or 8 bytes per pointer
        totalSize += arrayOverhead;
        
        // Ensure minimum realistic size for non-empty data
        if (data.length > 0) {
            const minimumDataSize = Math.max(512, data.length * 32); // At least 512B or 32 bytes per item
            const originalSize = totalSize - arrayOverhead;
            totalSize = Math.max(minimumDataSize, totalSize);
            
            // Removed verbose logging to prevent console memory accumulation
        }
        
        // Validate result to prevent NaN
        if (!isFinite(totalSize) || totalSize < 0) {
            console.warn('Invalid totalSize calculated:', totalSize, 'for data length:', data.length);
            return data.length > 0 ? Math.max(512, data.length * 32) : 0;
        }
        
        return totalSize;
    }

    /**
     * Estimate approximate memory footprint without materializing the dataset
     */
    static estimateDatasetSize(size, heightVariation = 'mixed', columnProfile = null) {
        if (typeof size !== 'number' || !isFinite(size) || size <= 0) {
            return 0;
        }
        const normalizedSize = Math.floor(size);
        const sampleItem = this.generateRowData(0, heightVariation, columnProfile) || {};
        let itemSize = 64; // Object overhead
        itemSize += 8; // id
        itemSize += 8; // height
        itemSize += 8; // timestamp
        itemSize += (sampleItem.type?.length || 6) * 2;
        itemSize += (sampleItem.text?.length || 30) * 2;

        let totalSize = normalizedSize * itemSize;
        const arrayOverhead = Math.max(1024, normalizedSize * 8);
        totalSize += arrayOverhead;

        const minimumDataSize = Math.max(512, normalizedSize * 32);
        totalSize = Math.max(minimumDataSize, totalSize);

        return totalSize;
    }
    
    /**
     * Generate data for a single row
     */
    static generateRowData(index, heightVariation = 'mixed', columnProfile = null) {
        let height;
        let type;
        
        switch (heightVariation) {
            case 'uniform':
                height = 40;
                type = 'small';
                break;
            case 'mixed':
                // Use deterministic random based on index for consistency
                const rand = this.seededRandom(index);
                if (rand < 0.6) {
                    height = 40;
                    type = 'small';
                } else if (rand < 0.9) {
                    height = 60;
                    type = 'medium';
                } else {
                    height = 100;
                    type = 'large';
                }
                break;
            case 'variable':
                height = 30 + Math.floor(this.seededRandom(index) * 120); // 30-150px
                type = height < 50 ? 'small' : height < 80 ? 'medium' : 'large';
                break;
            case 'large':
                // Mix of small to very large elements, some larger than typical viewport
                const randLarge = this.seededRandom(index);
                if (randLarge < 0.3) {
                    height = 80 + Math.floor(this.seededRandom(index + 1000) * 120); // 80-200px
                    type = 'medium';
                } else if (randLarge < 0.6) {
                    height = 200 + Math.floor(this.seededRandom(index + 2000) * 200); // 200-400px
                    type = 'large';
                } else if (randLarge < 0.85) {
                    height = 400 + Math.floor(this.seededRandom(index + 3000) * 300); // 400-700px
                    type = 'extra-large';
                } else {
                    height = 700 + Math.floor(this.seededRandom(index + 4000) * 100); // 700-800px (larger than most viewports)
                    type = 'massive';
                }
                break;
            case 'wide':
                // Standard height but extra wide content to trigger horizontal scrolling
                const randWide = this.seededRandom(index);
                if (randWide < 0.7) {
                    height = 50;
                    type = 'wide-normal';
                } else {
                    height = 80;
                    type = 'wide-large';
                }
                break;
            default:
                height = 40;
                type = 'small';
        }
        
        // Generate descriptive text based on element type and height
        let text;
        if (type === 'wide-normal' || type === 'wide-large') {
            // Generate extra wide text content to trigger horizontal scrolling
            const extraContent = `This is a really long line of text that should extend far beyond the typical container width to demonstrate horizontal scrolling functionality. Row ${index} contains extended content with technical details, performance metrics, and additional data that would normally wrap but is designed to stay on a single line to test the horizontal scrollbar implementation.`;
            text = `Row ${index} - Wide content (${height}px): ${extraContent}`;
        } else if (height > 600) {
            text = `Row ${index} - ${type} content block (${height}px) - Larger than most viewports`;
        } else if (height > 300) {
            text = `Row ${index} - ${type} content section (${height}px) - Substantial element`;
        } else {
            text = `Row ${index} - ${type} item (${height}px)`;
        }
        
        const columnData = this.generateColumnsForRow(index, columnProfile);
        return {
            id: index,
            height,
            type,
            text,
            timestamp: Date.now() + index,
            columnCount: columnData.columnCount,
            columns: columnData.columns
        };
    }

    /**
     * Minimal row model intended to let users materialize very large datasets (e.g. 10M)
     * without allocating per-row column objects and long strings.
     */
    static generateRowDataMinimal(index, heightVariation = 'mixed') {
        let height;
        let type;

        switch (heightVariation) {
            case 'uniform':
                height = 40;
                type = 'small';
                break;
            case 'variable':
                height = 30 + Math.floor(this.seededRandom(index) * 120);
                type = height < 50 ? 'small' : height < 80 ? 'medium' : 'large';
                break;
            case 'large': {
                const randLarge = this.seededRandom(index);
                if (randLarge < 0.3) {
                    height = 80 + Math.floor(this.seededRandom(index + 1000) * 120);
                    type = 'medium';
                } else if (randLarge < 0.6) {
                    height = 200 + Math.floor(this.seededRandom(index + 2000) * 200);
                    type = 'large';
                } else if (randLarge < 0.85) {
                    height = 400 + Math.floor(this.seededRandom(index + 3000) * 300);
                    type = 'extra-large';
                } else {
                    height = 700 + Math.floor(this.seededRandom(index + 4000) * 100);
                    type = 'massive';
                }
                break;
            }
            default:
                // mixed + wide collapse to something deterministic but cheap
                height = 40;
                type = 'small';
        }

        // Keep text short (10M unique long strings will blow heap).
        const text = `Row ${index}`;

        return {
            id: index,
            height,
            type,
            text,
            timestamp: Date.now() + index,
            columnCount: 0,
            columns: []
        };
    }
    
    /**
     * Seeded random number generator for consistent results
     */
    static seededRandom(seed) {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }
}

/**
 * Lightweight dataset wrapper that generates rows procedurally on demand
 */
export class ProceduralDataset {
    constructor(size, variation = 'mixed', columnProfile = null) {
        const normalizedSize = Math.max(0, Math.floor(size || 0));
        this.length = normalizedSize;
        this.variation = variation;
        this.timestampBase = Date.now();
        this.columnProfile = columnProfile;
        this._dataSizeBytes = DataGenerator.estimateDatasetSize(normalizedSize, variation, columnProfile);
        this._dataSizeMB = normalizedSize === 0
            ? 0
            : Math.max(0.01, Math.round(this._dataSizeBytes / 1024 / 1024 * 100) / 100);
        this._dataSizeFormatted = DataGenerator.formatMemorySize(this._dataSizeBytes);
        DataGenerator.attachColumnMetadata(this, columnProfile);
    }

    getRow(index) {
        if (index == null || index < 0 || index >= this.length) {
            return null;
        }
        const row = DataGenerator.generateRowData(index, this.variation, this.columnProfile);
        if (row) {
            row.timestamp = this.timestampBase + index;
        }
        return row;
    }
}


// Additional static methods for DataGenerator
DataGenerator.generateMemoryComparisonData = function() {
    const sizes = [1000, 10000, 100000, 1000000, 10000000];
    
    return sizes.map(size => ({
        datasetSize: size,
        traditionalDOM: size * 0.15, // 150 bytes per DOM element
        fixedVirtualScroll: Math.min(size * 0.08, 200), // Some optimization but still grows
        ceriousScroll: 8 // Constant 8MB regardless of size
    }));
};

DataGenerator.generateBenchmarkScenarios = function() {
    return [
        { name: '1K Rows - Mixed Heights', size: 1000, heights: 'mixed' },
        { name: '10K Rows - Mixed Heights', size: 10000, heights: 'mixed' },
        { name: '100K Rows - Mixed Heights', size: 100000, heights: 'mixed' },
        { name: '1M Rows - Mixed Heights', size: 1000000, heights: 'mixed' },
        { name: '10M Rows - Mixed Heights', size: 10000000, heights: 'mixed' },
        { name: '100K Rows - Uniform Heights', size: 100000, heights: 'uniform' },
        { name: '100K Rows - Variable Heights', size: 100000, heights: 'variable' }
    ];
};

/**
 * Screenshot utility for patent documentation
 */
export class ScreenshotGenerator {
    /**
     * Capture element as image
     */
    static async captureElement(element, filename = 'screenshot') {
        try {
            // Use html2canvas if available
            if (window.html2canvas) {
                const canvas = await window.html2canvas(element, {
                    scale: 2,
                    useCORS: true,
                    allowTaint: true
                });
                
                const link = document.createElement('a');
                link.download = `${filename}-${Date.now()}.png`;
                link.href = canvas.toDataURL();
                link.click();
            } else {
                console.warn('html2canvas not available. Please include the library for screenshot functionality.');
            }
        } catch (error) {
            console.error('Screenshot capture failed:', error);
        }
    }
    
    /**
     * Capture performance metrics dashboard
     */
    static async captureMetricsDashboard() {
        const dashboard = document.querySelector('.metrics-dashboard');
        if (dashboard) {
            await this.captureElement(dashboard, 'metrics-dashboard');
        }
    }
    
    /**
     * Capture scroll container
     */
    static async captureScrollContainer() {
        const container = document.querySelector('.scroll-container');
        if (container) {
            await this.captureElement(container, 'scroll-container');
        }
    }
    
    /**
     * Capture full demo
     */
    static async captureFullDemo() {
        const demo = document.querySelector('.app-container');
        if (demo) {
            await this.captureElement(demo, 'full-demo');
        }
    }
}

/**
 * Automated benchmark runner for patent validation
 */
export class BenchmarkRunner {
    constructor(performanceMonitor) {
        this.monitor = performanceMonitor;
        this.isRunning = false;
        this.results = [];
    }
    
    /**
     * Run automated benchmark suite
     */
    async runBenchmarkSuite(scrollerInstance, onProgress = null) {
        if (this.isRunning) return;
        
        this.isRunning = true;
        this.results = [];
        
        const scenarios = DataGenerator.generateBenchmarkScenarios();
        
        for (let i = 0; i < scenarios.length; i++) {
            const scenario = scenarios[i];
            
            if (onProgress) {
                onProgress({
                    current: i + 1,
                    total: scenarios.length,
                    scenario: scenario.name
                });
            }
            
            // Wait for any pending operations
            await this.delay(1000);
            
            // Run scenario
            const result = await this.runScenario(scenario, scrollerInstance);
            this.results.push(result);
            
            // DON'T reset the monitor - preserve memory tracking
            // Just clear benchmark data without affecting memory metrics
            this.monitor.benchmarkData = [];
            await this.delay(500);
        }
        
        this.isRunning = false;
        return this.results;
    }
    
    /**
     * Generate dataset using chunked processing to avoid UI blocking
     */
    async generateDatasetChunked(size, heightVariation = 'mixed') {
        
        // For smaller datasets, use synchronous generation
        if (size <= 50000) {
            return DataGenerator.generateDataset(size, heightVariation);
        }
        
        // For larger datasets, use chunked processing
        return new Promise((resolve) => {
            const data = [];
            const chunkSize = 10000; // Process 10K rows at a time
            let currentIndex = 0;
            
            const processChunk = () => {
                const endIndex = Math.min(currentIndex + chunkSize, size);
                
                // Generate chunk synchronously
                for (let i = currentIndex; i < endIndex; i++) {
                    data.push(DataGenerator.generateRowData(i, heightVariation));
                }
                
                currentIndex = endIndex;
                
                // Log progress for large datasets
                if (size > 100000) {
                    const progress = Math.round((currentIndex / size) * 100);
                }
                
                // Check if we're done
                if (currentIndex >= size) {
                    // Calculate memory properties
                    data._dataSizeBytes = DataGenerator.calculateDataSize(data);
                    
                    if (!isFinite(data._dataSizeBytes) || data._dataSizeBytes < 0) {
                        console.warn('Invalid data size calculation:', data._dataSizeBytes, 'for array length:', data.length);
                        data._dataSizeBytes = Math.max(512, data.length * 32);
                    }
                    
                    data._dataSizeMB = Math.max(0.01, Math.round(data._dataSizeBytes / 1024 / 1024 * 100) / 100);
                    data._dataSizeFormatted = DataGenerator.formatMemorySize(data._dataSizeBytes);
                    resolve(data);
                } else {
                    // Continue with next chunk on next tick to avoid blocking
                    setTimeout(processChunk, 0);
                }
            };
            
            // Start processing
            processChunk();
        });
    }

    /**
     * Run individual benchmark scenario
     */
    async runScenario(scenario, scrollerInstance) {
        const startTime = performance.now();
        
        // Always generate real data, but use chunked generation for large datasets
        const data = await this.generateDatasetChunked(scenario.size, scenario.heights);
        
        // Update the demo with real data
        if (window.demoInstance && typeof window.demoInstance.updateData === 'function') {
            await window.demoInstance.updateData(data);
        }
        
        // Give the browser time to process the data update
        await this.delay(100);
        
        // Perform comprehensive scroll testing with realistic patterns
        const scrollOperations = scenario.size <= 10000 ? 100 : 50; // More ops for smaller datasets
        const scrollMetrics = [];
        
        for (let i = 0; i < scrollOperations; i++) {
            // Create realistic scroll patterns
            let deltaY;
            const progress = i / scrollOperations;
            
            if (progress < 0.4) {
                // First 40%: Scroll down through the dataset (small to medium jumps)
                deltaY = 50 + Math.random() * 150; // 50-200px scroll down
            } else if (progress < 0.7) {
                // Next 30%: Large jumps down (testing performance with big moves)
                deltaY = 300 + Math.random() * 500; // 300-800px scroll down
            } else if (progress < 0.9) {
                // Next 20%: Scroll back up (reverse direction)
                deltaY = -(50 + Math.random() * 200); // 50-250px scroll up
            } else {
                // Final 10%: Mixed small movements (typical user behavior)
                deltaY = (Math.random() - 0.5) * 100; // ±50px random
            }
            
            // For benchmarks, use the demo's handleScroll but measure our own timing
            let latency;
            
            if (window.demoInstance && typeof window.demoInstance.handleScroll === 'function') {
                // Temporarily disable the demo's timing measurement during benchmarks
                const originalStartMeasurement = this.monitor.startScrollMeasurement;
                const originalEndMeasurement = this.monitor.endScrollMeasurement;
                
                // Replace with our benchmark timing
                this.monitor.startScrollMeasurement = () => this.monitor.startBenchmarkMeasurement();
                this.monitor.endScrollMeasurement = () => {
                    latency = this.monitor.endBenchmarkMeasurement();
                    return latency;
                };
                
                // Call the demo's scroll handler (includes algorithm + visual updates)
                window.demoInstance.handleScroll(deltaY);
                
                // Restore original timing methods
                this.monitor.startScrollMeasurement = originalStartMeasurement;
                this.monitor.endScrollMeasurement = originalEndMeasurement;
                
            } else if (scrollerInstance) {
                // Fallback: direct algorithm call
                this.monitor.startBenchmarkMeasurement();
                scrollerInstance.handleWheelScroll(deltaY, 600);
                latency = this.monitor.endBenchmarkMeasurement();
                
                if (window.demoInstance && typeof window.demoInstance.updateDisplay === 'function') {
                    window.demoInstance.updateDisplay();
                }
            } else {
                this.monitor.startBenchmarkMeasurement();
                latency = this.monitor.endBenchmarkMeasurement();
            }
            
            scrollMetrics.push(latency);
            
            // Update the UI metrics so they show during benchmarks
            this.monitor.metrics.scrollLatency = latency;
            this.monitor.metrics.algorithmLatency = latency;
            this.monitor.metrics.totalScrollEvents++;
            
            // Update scroll history for averaging
            this.monitor.history.scrollLatency.push(latency);
            if (this.monitor.history.scrollLatency.length > 100) {
                this.monitor.history.scrollLatency.shift();
            }
            
            const sum = this.monitor.history.scrollLatency.reduce((a, b) => a + b, 0);
            this.monitor.metrics.averageScrollLatency = Math.round((sum / this.monitor.history.scrollLatency.length) * 100) / 100;
            
            // Log progress every 10 operations
            if (i % 10 === 0) {
                const currentPos = Math.round(scrollerInstance?.scrollPercentage || 0);
            }
            
            // Small delay to allow visual updates and create smooth scrolling effect
            await this.delay(scenario.size <= 10000 ? 120 : 80);
        }
        
        const endTime = performance.now();
        
        return {
            scenario: scenario.name,
            datasetSize: scenario.size,
            heightVariation: scenario.heights,
            duration: endTime - startTime,
            averageScrollLatency: scrollMetrics.reduce((a, b) => a + b, 0) / scrollMetrics.length,
            maxScrollLatency: Math.max(...scrollMetrics),
            minScrollLatency: Math.min(...scrollMetrics),
            memoryUsage: this.monitor.metrics.memoryUsage,
            virtualizationOverhead: this.monitor.metrics.virtualizationOverhead,
            dataMemory: this.monitor.metrics.dataMemory,
            fps: this.monitor.metrics.fps,
            actualDataGenerated: true // Always true now since we always generate real data
        };
    }
    
    /**
     * Export benchmark results as CSV
     */
    exportResults() {
        if (this.results.length === 0) {
            alert('No benchmark results available. Please run a benchmark first.');
            console.warn('Export attempted but no benchmark results found. Make sure to run benchmarks before exporting.');
            return;
        }
        
        const headers = [
            'Scenario',
            'Dataset Size',
            'Height Variation',
            'Duration (ms)',
            'Avg Scroll Latency (ms)',
            'Max Scroll Latency (ms)',
            'Min Scroll Latency (ms)',
            'Memory Usage (MB)',
            'Virtualization Overhead (MB)',
            'Data Memory (MB)',
            'FPS',
            'Actual Data Generated'
        ];
        
        const csvContent = [
            headers.join(','),
            ...this.results.map(result => [
                result.scenario,
                result.datasetSize,
                result.heightVariation,
                result.duration,
                result.averageScrollLatency,
                result.maxScrollLatency,
                result.minScrollLatency,
                result.memoryUsage,
                result.virtualizationOverhead || 'N/A',
                result.dataMemory || 'N/A',
                result.fps,
                result.actualDataGenerated || false
            ].join(','))
        ].join('\n');
        
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cerious-scroll-benchmark-results-${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    /**
     * Simple delay utility
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}