export type UserRole = "business" | "worker";

export type ShiftStatus = "open" | "filled" | "cancelled" | "completed";

export type ApplicationStatus = "pending" | "accepted" | "declined";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          role: UserRole;
          full_name: string;
          company_name: string | null;
          phone: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          role: UserRole;
          full_name: string;
          company_name?: string | null;
          phone?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          role?: UserRole;
          full_name?: string;
          company_name?: string | null;
          phone?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      shifts: {
        Row: {
          id: string;
          business_id: string;
          title: string;
          description: string | null;
          location: string;
          starts_at: string;
          ends_at: string;
          hourly_rate: number;
          status: ShiftStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          title: string;
          description?: string | null;
          location: string;
          starts_at: string;
          ends_at: string;
          hourly_rate: number;
          status?: ShiftStatus;
          created_at?: string;
        };
        Update: {
          id?: string;
          business_id?: string;
          title?: string;
          description?: string | null;
          location?: string;
          starts_at?: string;
          ends_at?: string;
          hourly_rate?: number;
          status?: ShiftStatus;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shifts_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      shift_applications: {
        Row: {
          id: string;
          shift_id: string;
          worker_id: string;
          status: ApplicationStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          shift_id: string;
          worker_id: string;
          status?: ApplicationStatus;
          created_at?: string;
        };
        Update: {
          id?: string;
          shift_id?: string;
          worker_id?: string;
          status?: ApplicationStatus;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shift_applications_shift_id_fkey";
            columns: ["shift_id"];
            isOneToOne: false;
            referencedRelation: "shifts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "shift_applications_worker_id_fkey";
            columns: ["worker_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
