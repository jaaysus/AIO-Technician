import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, HardDrive, Thermometer, AlertCircle, CheckCircle, Zap } from "lucide-react";
import { APP_LOGO, APP_TITLE } from "@/const";

interface Drive {
  Device: string;
  Type: string;
  Model: string;
  Serial: string;
  HealthPercent?: number;
  WrittenGB: number;
  PowerCycles: number;
  PowerOnHours: number;
  LiveTemperatureC?: number;
  error?: boolean;
  message?: string;
}

interface Volume {
  DriveLetter: string;
  FreeGB: number;
  UsedGB: number;
  UsagePercent: number;
}

interface ApiResponse {
  Drives: Drive[];
  Volumes: Volume[];
}

export default function Home() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const API_URL = "http://localhost:54321/api/drives/stream";

  const fetchDrives = async () => {
    try {
      const response = await fetch("http://localhost:54321/api/drives");
      if (!response.ok) throw new Error("Failed to fetch drives");
      const json = await response.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    // Initial data load
    fetchDrives();

    // Set up real-time updates
    const eventSource = new EventSource(API_URL);

    eventSource.onmessage = (event) => {
      try {
        const json = JSON.parse(event.data);
        setData(prevData => prevData ? {
          ...prevData,
          Drives: json.Drives
        } : json);
        setError(null);
      } catch (err) {
        setError("Failed to parse drive data");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    };

    eventSource.onerror = () => {
      setError("Lost connection to drive monitoring service. Reconnecting...");
      setLoading(true);
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchDrives();
  };

  const getHealthColor = (percent?: number) => {
    if (percent === undefined) return "text-gray-500";
    if (percent >= 80) return "text-green-600";
    if (percent >= 50) return "text-yellow-600";
    return "text-red-600";
  };

  const getTempColor = (temp?: number) => {
    if (temp === undefined) return "text-gray-500";
    if (temp <= 40) return "text-blue-600";
    if (temp <= 50) return "text-green-600";
    if (temp <= 60) return "text-yellow-600";
    return "text-red-600";
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <HardDrive className="w-8 h-8 text-primary" />
              <h1 className="text-3xl font-bold text-foreground">AIO Technician</h1>
            </div>
            <Button onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Refresh
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {loading ? (
          <div className="flex items-center justify-center min-h-96">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : error ? (
          <Card className="border-red-200 bg-red-50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-700">
                <AlertCircle className="w-5 h-5" />
                Error
              </CardTitle>
            </CardHeader>
            <CardContent className="text-red-600">{error}</CardContent>
          </Card>
        ) : data ? (
          <div className="space-y-8">
            {/* Drives Section */}
            <section>
              <h2 className="text-2xl font-bold text-foreground mb-4">Storage Devices</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {data.Drives.map((drive) => (
                  <Card key={drive.Device} className="hover:shadow-lg transition-shadow">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <HardDrive className="w-5 h-5" />
                        {drive.Device}
                      </CardTitle>
                      <CardDescription>{drive.Model}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {drive.error ? (
                        <div className="text-red-600 flex items-center gap-2">
                          <AlertCircle className="w-4 h-4" />
                          {drive.message}
                        </div>
                      ) : (
                        <>
                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <p className="text-muted-foreground">Type</p>
                              <p className="font-semibold text-foreground capitalize">{drive.Type}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Serial</p>
                              <p className="font-semibold text-foreground text-xs">{drive.Serial}</p>
                            </div>
                          </div>

                          {/* Health Status */}
                          {drive.HealthPercent !== undefined && (
                            <div>
                              <div className="flex items-center justify-between mb-2">
                                <p className="text-muted-foreground text-sm">Health</p>
                                <p className={`font-bold ${getHealthColor(drive.HealthPercent)}`}>
                                  {drive.HealthPercent}%
                                </p>
                              </div>
                              <div className="w-full bg-gray-200 rounded-full h-2">
                                <div
                                  className={`h-2 rounded-full transition-all ${
                                    drive.HealthPercent >= 80
                                      ? "bg-green-600"
                                      : drive.HealthPercent >= 50
                                      ? "bg-yellow-600"
                                      : "bg-red-600"
                                  }`}
                                  style={{ width: `${drive.HealthPercent}%` }}
                                />
                              </div>
                            </div>
                          )}

                          {/* Temperature */}
                          {drive.LiveTemperatureC !== undefined && (
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Thermometer className={`w-4 h-4 ${getTempColor(drive.LiveTemperatureC)}`} />
                                <p className="text-muted-foreground text-sm">Temperature</p>
                              </div>
                              <p className={`font-bold ${getTempColor(drive.LiveTemperatureC)}`}>
                                {drive.LiveTemperatureC}°C
                              </p>
                            </div>
                          )}

                          {/* Power Stats */}
                          <div className="grid grid-cols-2 gap-4 text-sm border-t border-border pt-4">
                            <div>
                              <p className="text-muted-foreground">Power On Hours</p>
                              <p className="font-semibold text-foreground">{drive.PowerOnHours.toLocaleString()}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Power Cycles</p>
                              <p className="font-semibold text-foreground">{drive.PowerCycles.toLocaleString()}</p>
                            </div>
                            <div className="col-span-2">
                              <p className="text-muted-foreground">Written</p>
                              <p className="font-semibold text-foreground">{drive.WrittenGB.toLocaleString()} GB</p>
                            </div>
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>

            {/* Volumes Section */}
            {data.Volumes && data.Volumes.length > 0 && (
              <section>
                <h2 className="text-2xl font-bold text-foreground mb-4">Disk Volumes</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {data.Volumes.map((volume) => (
                    <Card key={volume.DriveLetter}>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <Zap className="w-5 h-5" />
                          {volume.DriveLetter}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-muted-foreground">Usage</p>
                          <p className="font-bold text-foreground">{volume.UsagePercent.toFixed(1)}%</p>
                        </div>
                        <div className="w-full bg-gray-200 rounded-full h-3">
                          <div
                            className={`h-3 rounded-full transition-all ${
                              volume.UsagePercent >= 80
                                ? "bg-red-600"
                                : volume.UsagePercent >= 60
                                ? "bg-yellow-600"
                                : "bg-green-600"
                            }`}
                            style={{ width: `${volume.UsagePercent}%` }}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4 text-sm border-t border-border pt-4">
                          <div>
                            <p className="text-muted-foreground">Used</p>
                            <p className="font-semibold text-foreground">{volume.UsedGB.toFixed(2)} GB</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Free</p>
                            <p className="font-semibold text-foreground">{volume.FreeGB.toFixed(2)} GB</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}
